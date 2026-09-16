import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { TenantContextStore } from '@app/tenant-context';
import { Role } from '@app/common';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { ResourceRepository } from '../../../apps/resource-service/src/resources/resource.repository';
import { Resource } from '../../../apps/resource-service/src/resources/resource.entity';
import { PlanLimitCache } from '../../../apps/resource-service/src/resources/plan-limit-cache.entity';
import { CreateResourcesAndPlanLimitCache1700000000001 } from '../../../apps/resource-service/src/database/migrations/1700000000001-CreateResourcesAndPlanLimitCache';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/**
 * §13.1, §13.8 check #3 — THE MOST IMPORTANT TEST IN THIS SERVICE, and the
 * executable form of this architecture's central claim.
 *
 * The claim: tenant isolation is STRUCTURAL. It holds even when the developer
 * who wrote the query forgot to scope it — because the filter is not in the
 * application at all, it is a PostgreSQL row-level security policy applied to
 * raw SQL before rows are returned.
 *
 * Everything here runs against a real Postgres container as the real app_user
 * role (NOSUPERUSER, NOBYPASSRLS, non-owner) with the real migration — the
 * three properties the guarantee actually depends on. None of this can be
 * mocked: a fake would be testing the fake.
 *
 * IF THIS FILE IS EVER DELETED OR SKIPPED, THE ARCHITECTURE'S CENTRAL CLAIM
 * IS UNVERIFIED. Treat a change to it as an architecture change.
 */
describe('resource-service tenant isolation — real PostgreSQL RLS (§13.1)', () => {
  jest.setTimeout(120_000);

  const db = new PostgresTestContainer();
  const tenantContext = new TenantContextStore();
  const repo = new ResourceRepository(tenantContext);

  beforeAll(async () => {
    await db.start([Resource, PlanLimitCache]);
    await db.runMigration(async (qr) => {
      await new CreateResourcesAndPlanLimitCache1700000000001().up(qr);
    });
    await db.connectAppDataSource();
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  function contextFor(organizationId: string, userId: string) {
    return {
      userId,
      organizationId,
      roles: [Role.ORG_ADMIN],
      correlationId: 'corr-1',
      iat: 0,
      exp: 0,
    };
  }

  /** Exactly what TenantAwareDataSource.transaction() does in production. */
  async function asOrg<T>(
    organizationId: string,
    userId: string,
    work: (manager: import('typeorm').EntityManager) => Promise<T>,
  ): Promise<T> {
    const runner = db.appDataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query("SELECT set_config('app.current_org', $1, true)", [organizationId]);
      const result = await tenantContext.run(contextFor(organizationId, userId), () =>
        work(runner.manager),
      );
      await runner.commitTransaction();
      return result;
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  let orgAResourceId: string;
  let orgBResourceId: string;

  beforeEach(async () => {
    // Clear both orgs' rows. Note each DELETE must run in its own scoped
    // transaction — under FORCE RLS, org A's connection cannot delete org B's
    // rows even deliberately, which is itself part of the guarantee.
    for (const org of [ORG_A, ORG_B]) {
      await asOrg(org, USER_A, (manager) => manager.query(`DELETE FROM resources`));
    }

    orgAResourceId = await asOrg(ORG_A, USER_A, async (manager) => {
      const created = await repo.create(
        { name: 'org-a-secret.pdf', description: 'A', sizeBytes: 100, createdBy: USER_A },
        manager,
      );
      return created.id;
    });

    orgBResourceId = await asOrg(ORG_B, USER_B, async (manager) => {
      const created = await repo.create(
        { name: 'org-b-secret.pdf', description: 'B', sizeBytes: 200, createdBy: USER_B },
        manager,
      );
      return created.id;
    });
  });

  describe('the careless query (§13.1 — the central claim)', () => {
    /**
     * THE TEST. `findAllResourcesForReport` is a raw
     * `SELECT * FROM resources` with NO WHERE clause and no tenant filter of
     * any kind — the literal code §13.1 says "a new developer writes this".
     * Two organisations' rows exist. Only the caller's come back.
     *
     * The developer's omission produces no leak. It cannot: the filter is not
     * in the application.
     */
    it('a raw SELECT * with NO WHERE clause returns ONLY the calling tenant\'s rows', async () => {
      const asA = await asOrg(ORG_A, USER_A, (manager) =>
        repo.findAllResourcesForReport(manager),
      );

      expect(asA).toHaveLength(1);
      expect(asA[0].id).toBe(orgAResourceId);
      expect(asA[0].organization_id).toBe(ORG_A);
      // Org B's row exists in the table and is simply not visible here.
      expect(asA.map((r) => r.id)).not.toContain(orgBResourceId);
      expect(asA.map((r) => r.name)).not.toContain('org-b-secret.pdf');
    });

    it('the same careless query run as org B returns only org B\'s rows — symmetric, not an artefact of seeding', async () => {
      const asB = await asOrg(ORG_B, USER_B, (manager) =>
        repo.findAllResourcesForReport(manager),
      );

      expect(asB).toHaveLength(1);
      expect(asB[0].id).toBe(orgBResourceId);
      expect(asB.map((r) => r.id)).not.toContain(orgAResourceId);
    });

    /**
     * §13.7 row 4, and §13.6's platform-admin path — the "developer opened a
     * connection outside the wrapper" and "orgId is null" cases. Both must
     * read NOTHING rather than everything: the guarantee fails CLOSED.
     *
     * §32.4: this is the regression test for a real bug found via empirical
     * Postgres testing. `set_config('app.current_org', $1, true)` is
     * transaction-LOCAL, so at commit the setting reverts to the EMPTY
     * STRING, never back to NULL — and that empty string persists for the
     * rest of the connection's session. Since a connection pool reuses
     * connections that have already served a scoped transaction, "unscoped"
     * in production almost always means "previously scoped, now carrying a
     * leftover empty string," not "genuinely never set." Before the fix, the
     * policy's `current_setting(...)::uuid` cast RAISED on that empty string
     * instead of returning zero rows — turning this exact query into a 500,
     * and silently disabling every caller that relies on "unscoped -> zero
     * rows" (the cross-tenant detection probe in ResourcesService, the
     * pre-scope phase of transactionWithDeferredScope, the platform-admin
     * path). Fixed at the policy itself (enableTenantRls now wraps the
     * setting in `NULLIF(..., '')` before the cast) rather than in this test,
     * because every RLS-protected table's policy needed the same fix.
     *
     * This test deliberately runs on `db.appDataSource` — a connection this
     * suite's own `beforeEach` has already used for scoped transactions —
     * specifically to exercise the REUSED-connection path, not a fresh one.
     */
    it('an UNSCOPED connection (reused from a prior scoped transaction) returns zero rows, not an error', async () => {
      const leaked = await db.appDataSource.query<unknown[]>('SELECT * FROM resources');
      expect(leaked).toHaveLength(0);
    });

    /** §13.6: a platform admin's context (orgId null) is structurally contentless. */
    it('a platform-admin-shaped connection (no org scope) gets no content either', async () => {
      const runner = db.appDataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        // No set_config at all — exactly what TenantAwareDataSource does when
        // organizationId is null. This connection was ALSO reused from a
        // prior scoped transaction (same underlying pool), so it exercises
        // the identical reused-connection path as the test above.
        const leaked = await runner.manager.query<unknown[]>('SELECT * FROM resources');
        expect(leaked).toHaveLength(0);
      } finally {
        await runner.commitTransaction();
        await runner.release();
      }
    });
  });

  describe('cross-tenant read by ID (§13, H1 — the sharpest test)', () => {
    it('org A cannot read org B\'s resource by id — it comes back null, exactly as if absent', async () => {
      const found = await asOrg(ORG_A, USER_A, (manager) =>
        repo.findById(orgBResourceId, manager),
      );
      expect(found).toBeNull();
    });

    it('a well-formed id for a resource that genuinely does not exist is INDISTINGUISHABLE from the above', async () => {
      const foreign = await asOrg(ORG_A, USER_A, (manager) =>
        repo.findById(orgBResourceId, manager),
      );
      const missing = await asOrg(ORG_A, USER_A, (manager) =>
        repo.findById('99999999-9999-9999-9999-999999999999', manager),
      );
      // Both null. The repository has no way to tell them apart, which is
      // what forces the service to answer 404 for both (§13.9).
      expect(foreign).toBeNull();
      expect(missing).toBeNull();
    });

    it('org A\'s own resource IS readable by id — isolation, not breakage', async () => {
      const found = await asOrg(ORG_A, USER_A, (manager) =>
        repo.findById(orgAResourceId, manager),
      );
      expect(found?.id).toBe(orgAResourceId);
      expect(found?.name).toBe('org-a-secret.pdf');
      // bigintTransformer applied: a real number, not the string the pg
      // driver returns for a bigint column (§15.1).
      expect(found?.sizeBytes).toBe(100);
      expect(typeof found?.sizeBytes).toBe('number');
    });
  });

  describe('writes are isolated too (WITH CHECK, §13.5)', () => {
    /**
     * `USING` filters reads; `WITH CHECK` blocks writing a row INTO another
     * tenant. Without it, a buggy or malicious write could plant data in
     * org B even though it could never read it back.
     */
    it('org A cannot INSERT a row belonging to org B — WITH CHECK rejects it', async () => {
      await expect(
        asOrg(ORG_A, USER_A, (manager) =>
          manager.query(
            `INSERT INTO resources (organization_id, name, size_bytes, created_by)
             VALUES ($1, $2, $3, $4)`,
            [ORG_B, 'planted.pdf', 1, USER_A],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('org A cannot UPDATE org B\'s row — it matches zero rows rather than succeeding', async () => {
      await asOrg(ORG_A, USER_A, (manager) =>
        manager.query(`UPDATE resources SET name = 'hacked' WHERE id = $1`, [orgBResourceId]),
      );

      const stillIntact = await asOrg(ORG_B, USER_B, (manager) =>
        repo.findById(orgBResourceId, manager),
      );
      expect(stillIntact?.name).toBe('org-b-secret.pdf');
    });

    it('org A cannot DELETE org B\'s row', async () => {
      await asOrg(ORG_A, USER_A, (manager) =>
        manager.query(`DELETE FROM resources WHERE id = $1`, [orgBResourceId]),
      );

      const survived = await asOrg(ORG_B, USER_B, (manager) =>
        repo.findById(orgBResourceId, manager),
      );
      expect(survived).not.toBeNull();
    });
  });

  describe('list and aggregate paths are scoped too', () => {
    it('listPage returns only the calling tenant\'s rows', async () => {
      const page = await asOrg(ORG_A, USER_A, (manager) => repo.listPage({}, manager));
      expect(page.items).toHaveLength(1);
      expect(page.items[0].organizationId).toBe(ORG_A);
    });

    it('sumSizeBytesForOrg totals only the calling tenant\'s bytes', async () => {
      const totalA = await asOrg(ORG_A, USER_A, (manager) =>
        repo.sumSizeBytesForOrg(ORG_A, manager),
      );
      const totalB = await asOrg(ORG_B, USER_B, (manager) =>
        repo.sumSizeBytesForOrg(ORG_B, manager),
      );
      // 100 and 200 respectively — never 300, which is what an unscoped SUM
      // over the whole table would return.
      expect(totalA).toBe(100);
      expect(totalB).toBe(200);
      expect(typeof totalA).toBe('number');
    });

    it('a soft-deleted resource stops counting toward the org\'s total', async () => {
      await asOrg(ORG_A, USER_A, (manager) => repo.remove(orgAResourceId, manager));

      const total = await asOrg(ORG_A, USER_A, (manager) =>
        repo.sumSizeBytesForOrg(ORG_A, manager),
      );
      expect(total).toBe(0);

      // And the row is gone from ordinary reads, but still present for audit.
      const found = await asOrg(ORG_A, USER_A, (manager) =>
        repo.findById(orgAResourceId, manager),
      );
      expect(found).toBeNull();
    });
  });

  describe('the RLS configuration itself (§13.8 check #1)', () => {
    it('both tenant tables have RLS ENABLED and FORCED, with a policy carrying USING and WITH CHECK', async () => {
      const rows = await db.appDataSource.query<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relname IN ('resources', 'plan_limit_cache')
          ORDER BY relname`,
      );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.relrowsecurity).toBe(true);
        // FORCE is what makes the policy apply to the table OWNER too —
        // without it, app_migrator would bypass it silently.
        expect(row.relforcerowsecurity).toBe(true);
      }

      const policies = await db.appDataSource.query<
        { tablename: string; qual: string | null; with_check: string | null }[]
      >(
        `SELECT tablename, qual, with_check
           FROM pg_policies
          WHERE tablename IN ('resources', 'plan_limit_cache')
          ORDER BY tablename`,
      );

      expect(policies).toHaveLength(2);
      for (const policy of policies) {
        // USING filters reads/updates/deletes; WITH CHECK blocks planting a
        // row in another tenant. Neither is optional.
        expect(policy.qual).toContain('app.current_org');
        expect(policy.with_check).toContain('app.current_org');
      }
    });

    /**
     * §13.7 row 5 — the other genuine hole. RLS is void if the runtime role
     * is a superuser or carries BYPASSRLS. assertRlsSafeRole checks this at
     * boot; this asserts the test container mirrors production's role setup,
     * so every assertion above is meaningful rather than accidentally passing
     * against an over-privileged role.
     */
    it('the runtime role is NOT superuser and does NOT have BYPASSRLS', async () => {
      const [role] = await db.appDataSource.query<
        { rolsuper: boolean; rolbypassrls: boolean; rolname: string }[]
      >(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);

      expect(role.rolname).toBe('app_user');
      expect(role.rolsuper).toBe(false);
      expect(role.rolbypassrls).toBe(false);
    });
  });
});
