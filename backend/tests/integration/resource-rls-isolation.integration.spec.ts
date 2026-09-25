import { assertRlsSafeRole, runGlobal, transactionForOrganization } from '../../src/lib/tenant-db';
import * as resources from '../../src/models/resource.model';
import * as resourcesService from '../../src/services/resources.service';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { runAs } from '../support/tenant-fixtures';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/**
 * T2 — THE executable form of the architecture's central claim: tenant isolation is
 * structural. A query that forgot its tenant filter still returns only the caller's
 * rows, because the filter is a PostgreSQL RLS policy, not application code.
 *
 * Real Postgres 17, real migration, real app_user role (NOSUPERUSER, NOBYPASSRLS,
 * non-owner) — the three properties the guarantee depends on. None of it can be
 * mocked. IF THIS FILE IS EVER DELETED OR SKIPPED, THE CENTRAL CLAIM IS UNVERIFIED.
 */
describe('resources tenant isolation — real PostgreSQL RLS (T2)', () => {
  const db = new PostgresTestContainer();

  beforeAll(() => db.start());
  afterAll(() => db.stop());

  let orgAResourceIds: string[];
  let orgBResourceIds: string[];

  async function seed(org: string, user: string, names: string[], size: number) {
    return transactionForOrganization(org, async (tx) => {
      const ids: string[] = [];
      for (const name of names) {
        const created = await resources.create(tx, {
          organizationId: org,
          name,
          description: org === ORG_A ? 'A' : 'B',
          sizeBytes: size,
          createdBy: user,
        });
        ids.push(created.id);
      }
      return ids;
    });
  }

  beforeEach(async () => {
    // Each DELETE runs in its own org's scope: under FORCE RLS, one org's connection
    // cannot delete another's rows even deliberately — part of the guarantee.
    for (const org of [ORG_A, ORG_B]) {
      await transactionForOrganization(org, (tx) => tx.$executeRaw`DELETE FROM resources`);
    }
    // T2's canonical fixture: 3 rows for org A, 2 for org B.
    orgAResourceIds = await seed(ORG_A, USER_A, ['a-1.pdf', 'a-2.pdf', 'a-3.pdf'], 100);
    orgBResourceIds = await seed(ORG_B, USER_B, ['org-b-secret.pdf', 'b-2.pdf'], 200);
  });

  describe('the careless query (the central claim)', () => {
    it("a raw SELECT * with NO WHERE clause returns ONLY the calling tenant's rows (3, not 5)", async () => {
      const asA = await runAs(ORG_A, USER_A, () => resourcesService.findAllResourcesForReport());

      expect(asA).toHaveLength(3);
      expect(asA.map((r) => r.id).sort()).toEqual([...orgAResourceIds].sort());
      expect(asA.every((r) => r.organizationId === ORG_A)).toBe(true);
      expect(asA.map((r) => r.name)).not.toContain('org-b-secret.pdf');
    });

    it("the same careless query as org B returns only org B's rows — symmetric", async () => {
      const asB = await runAs(ORG_B, USER_B, () => resourcesService.findAllResourcesForReport());

      expect(asB).toHaveLength(2);
      expect(asB.map((r) => r.id).sort()).toEqual([...orgBResourceIds].sort());
      for (const id of orgAResourceIds) expect(asB.map((r) => r.id)).not.toContain(id);
    });

    it('the model-level careless query behaves identically inside a scoped transaction', async () => {
      const rows = await transactionForOrganization(ORG_A, (tx) =>
        resources.findAllResourcesForReport(tx),
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.organization_id === ORG_A)).toBe(true);
    });

    /**
     * Fails CLOSED with no tenant context. The pool has already served scoped
     * transactions (beforeEach), so this lands on a connection whose
     * app.current_org is the leftover '' rather than NULL — the reused-connection
     * trap NULLIF(..., '') in the policy exists for. Zero rows, not an error.
     */
    it('an UNSCOPED query on a reused pooled connection returns zero rows, not an error', async () => {
      const leaked = await db.prisma.$queryRaw<unknown[]>`SELECT * FROM resources`;
      expect(leaked).toHaveLength(0);
    });

    it('the same on a raw connection that just committed a scoped transaction (deterministic reuse)', async () => {
      await db.asAppUser(async (client) => {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_org', $1, true)", [ORG_A]);
        expect((await client.query('SELECT * FROM resources')).rows).toHaveLength(3);
        await client.query('COMMIT');

        // Documents the trap: '' after commit, not NULL.
        const setting = await client.query("SELECT current_setting('app.current_org', true) AS v");
        expect(setting.rows[0].v).toBe('');
        expect((await client.query('SELECT * FROM resources')).rows).toHaveLength(0);
      });
    });

    it('a platform-admin-shaped transaction (runGlobal, no org scope) gets no content either', async () => {
      const leaked = await runGlobal((tx) => resources.findAllResourcesForReport(tx));
      expect(leaked).toHaveLength(0);
    });

    it('a platform-admin context calling the service gets zero rows', async () => {
      const leaked = await runAs(null, USER_A, () => resourcesService.findAllResourcesForReport());
      expect(leaked).toHaveLength(0);
    });
  });

  describe('cross-tenant read by ID', () => {
    it("org A cannot read org B's resource by id — null, exactly as if absent", async () => {
      const found = await transactionForOrganization(ORG_A, (tx) =>
        resources.findById(tx, orgBResourceIds[0], ORG_A),
      );
      expect(found).toBeNull();
    });

    it('even with org B named in the WHERE clause, RLS still hides it from org A', async () => {
      // The application filter is wrong on purpose; the policy is the boundary.
      const found = await transactionForOrganization(ORG_A, (tx) =>
        resources.findById(tx, orgBResourceIds[0], ORG_B),
      );
      expect(found).toBeNull();
    });

    it('a foreign id is INDISTINGUISHABLE from a genuinely missing one', async () => {
      const [foreign, missing] = await transactionForOrganization(ORG_A, async (tx) => [
        await resources.findById(tx, orgBResourceIds[0], ORG_A),
        await resources.findById(tx, '99999999-9999-9999-9999-999999999999', ORG_A),
      ]);
      expect(foreign).toBeNull();
      expect(missing).toBeNull();
    });

    it("org A's own resource IS readable by id — isolation, not breakage", async () => {
      const found = await transactionForOrganization(ORG_A, (tx) =>
        resources.findById(tx, orgAResourceIds[0], ORG_A),
      );
      expect(found?.id).toBe(orgAResourceIds[0]);
      expect(found?.name).toBe('a-1.pdf');
      // bigint column surfaced as a real number.
      expect(found?.sizeBytes).toBe(100);
      expect(typeof found?.sizeBytes).toBe('number');
    });
  });

  describe('writes are isolated too (WITH CHECK)', () => {
    it('org A cannot INSERT a row belonging to org B — WITH CHECK rejects it', async () => {
      await expect(
        transactionForOrganization(
          ORG_A,
          (tx) => tx.$executeRaw`
            INSERT INTO resources (organization_id, name, size_bytes, created_by)
            VALUES (${ORG_B}::uuid, 'planted.pdf', 1, ${USER_A}::uuid)`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('the model create() cannot be talked into writing another org either', async () => {
      await expect(
        transactionForOrganization(ORG_A, (tx) =>
          resources.create(tx, {
            organizationId: ORG_B,
            name: 'planted.pdf',
            description: null,
            sizeBytes: 1,
            createdBy: USER_A,
          }),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("org A cannot UPDATE org B's row — it matches zero rows", async () => {
      const affected = await transactionForOrganization(
        ORG_A,
        (tx) =>
          tx.$executeRaw`UPDATE resources SET name = 'hacked' WHERE id = ${orgBResourceIds[0]}::uuid`,
      );
      expect(affected).toBe(0);

      const intact = await transactionForOrganization(ORG_B, (tx) =>
        resources.findById(tx, orgBResourceIds[0], ORG_B),
      );
      expect(intact?.name).toBe('org-b-secret.pdf');
    });

    it("org A cannot DELETE org B's row", async () => {
      const affected = await transactionForOrganization(
        ORG_A,
        (tx) => tx.$executeRaw`DELETE FROM resources WHERE id = ${orgBResourceIds[0]}::uuid`,
      );
      expect(affected).toBe(0);

      const survived = await transactionForOrganization(ORG_B, (tx) =>
        resources.findById(tx, orgBResourceIds[0], ORG_B),
      );
      expect(survived).not.toBeNull();
    });
  });

  describe('list and aggregate paths are scoped too', () => {
    it("listPage (service) returns only the calling tenant's rows", async () => {
      const page = await runAs(ORG_A, USER_A, () => resourcesService.listPage({}));
      expect(page.items).toHaveLength(3);
      expect(page.items.every((r) => r.organizationId === ORG_A)).toBe(true);
      expect(page.hasMore).toBe(false);
    });

    it("sumSizeBytesForOrg totals only the calling tenant's bytes", async () => {
      const totalA = await transactionForOrganization(ORG_A, (tx) =>
        resources.sumSizeBytesForOrg(tx, ORG_A),
      );
      const totalB = await transactionForOrganization(ORG_B, (tx) =>
        resources.sumSizeBytesForOrg(tx, ORG_B),
      );
      // Never 700, which an unscoped SUM over the whole table would return.
      expect(totalA).toBe(300);
      expect(totalB).toBe(400);
      expect(typeof totalA).toBe('number');
    });

    it("a soft-deleted resource stops counting toward the org's total", async () => {
      await transactionForOrganization(ORG_A, (tx) =>
        resources.remove(tx, orgAResourceIds[0], ORG_A),
      );

      const total = await transactionForOrganization(ORG_A, (tx) =>
        resources.sumSizeBytesForOrg(tx, ORG_A),
      );
      expect(total).toBe(200);

      // Gone from ordinary reads, still present for audit (the careless query sees it).
      const found = await transactionForOrganization(ORG_A, (tx) =>
        resources.findById(tx, orgAResourceIds[0], ORG_A),
      );
      expect(found).toBeNull();
      const raw = await transactionForOrganization(ORG_A, (tx) =>
        resources.findAllResourcesForReport(tx),
      );
      expect(raw.find((r) => r.id === orgAResourceIds[0])?.deleted_at).not.toBeNull();
    });
  });

  describe('the RLS configuration itself (structural guard)', () => {
    const TENANT_TABLES = [
      'invitations',
      'plan_limit_cache',
      'resources',
      'subscription_history',
      'subscriptions',
      'users',
    ];

    it('every tenant table has RLS ENABLED and FORCED, with USING and WITH CHECK on app.current_org', async () => {
      const rows = await db.prisma.$queryRaw<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        SELECT relname, relrowsecurity, relforcerowsecurity
          FROM pg_class
         WHERE relname = ANY(${TENANT_TABLES}::text[]) AND relkind = 'r'
         ORDER BY relname`;

      expect(rows.map((r) => r.relname)).toEqual(TENANT_TABLES);
      for (const row of rows) {
        expect(row.relrowsecurity).toBe(true);
        // FORCE is what applies the policy to the table OWNER too.
        expect(row.relforcerowsecurity).toBe(true);
      }

      const policies = await db.prisma.$queryRaw<
        { tablename: string; qual: string | null; with_check: string | null }[]
      >`
        SELECT tablename, qual, with_check FROM pg_policies
         WHERE tablename = ANY(${TENANT_TABLES}::text[])
         ORDER BY tablename`;

      expect(policies.map((p) => p.tablename)).toEqual(TENANT_TABLES);
      for (const policy of policies) {
        expect(policy.qual).toContain('app.current_org');
        expect(policy.with_check).toContain('app.current_org');
        // The reused-connection fix: '' must become NULL before the uuid cast.
        expect(policy.qual).toContain('NULLIF');
      }
    });

    it('every table carrying organization_id NOT NULL is RLS-protected (no unprotected tenant table)', async () => {
      const unprotected = await db.prisma.$queryRaw<{ table_name: string }[]>`
        SELECT c.table_name
          FROM information_schema.columns c
          JOIN pg_class p ON p.relname = c.table_name AND p.relkind = 'r'
         WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'
           AND (NOT p.relrowsecurity OR NOT p.relforcerowsecurity)
         ORDER BY c.table_name`;
      // The registry tables (organization_id is metadata there, not an owner) are the
      // only deliberate exceptions.
      expect(unprotected.map((r) => r.table_name)).toEqual(['credentials', 'onboarding_sagas']);
    });

    /**
     * RLS is void for a superuser or a BYPASSRLS role. This mirrors the boot-time
     * assertRlsSafeRole() check and proves the container matches production, so every
     * assertion above is meaningful rather than passing against an over-privileged role.
     */
    it('the runtime role is NOT superuser and does NOT have BYPASSRLS', async () => {
      const [role] = await db.prisma.$queryRaw<
        { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
      >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;

      expect(role.rolname).toBe('app_user');
      expect(role.rolsuper).toBe(false);
      expect(role.rolbypassrls).toBe(false);
      // And the boot-time guard agrees.
      await expect(assertRlsSafeRole()).resolves.toBeUndefined();
    });
  });
});
