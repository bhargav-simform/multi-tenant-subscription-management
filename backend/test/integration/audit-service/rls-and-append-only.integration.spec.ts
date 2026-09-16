import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import type { EntityManager } from 'typeorm';
import { TenantContextStore } from '@app/tenant-context';
import { Role } from '@app/common';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { AuditEvent } from '../../../apps/audit-service/src/audit/audit-event.entity';
import { SecurityEvent } from '../../../apps/audit-service/src/audit/security-event.entity';
import {
  AuditEventRepository,
  SecurityEventRepository,
} from '../../../apps/audit-service/src/audit/audit-record.repository';
import { CreateAuditAndSecurityEvents1700000000001 } from '../../../apps/audit-service/src/database/migrations/1700000000001-CreateAuditAndSecurityEvents';
import { CreateConsumedEvents1700000000002 } from '../../../apps/audit-service/src/database/migrations/1700000000002-CreateConsumedEvents';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let eventIdCounter = 0;
const nextEventId = (): string =>
  `eeeeeeee-0000-0000-0000-${String(++eventIdCounter).padStart(12, '0')}`;

/**
 * §8.7, §13.1, §13.9 — audit-service against a real PostgreSQL container, as
 * the real `app_user` role (NOSUPERUSER, NOBYPASSRLS, non-owner), with the real
 * migrations. Three properties are verified here and CANNOT be verified
 * anywhere else:
 *
 *   (a) RLS isolation between two orgs' audit and security events;
 *   (b) the NULLABLE-organization_id edge case — a genuinely org-less security
 *       event (a failed login before any org context exists) can be WRITTEN at
 *       all, is readable unscoped, and is invisible to every org-scoped read;
 *   (c) the append-only GRANT — app_user holds SELECT and INSERT on both tables
 *       and NOT UPDATE or DELETE (§8.7: "no UPDATE or DELETE is granted to the
 *       service's database role").
 *
 * (b) is the reason this file exists in the shape it does. These are the only
 * two tables in the system whose `organization_id` is nullable, and the
 * standard `enableTenantRls()` policy shape REJECTS an unscoped NULL-org insert
 * outright — both sides of `organization_id = NULLIF(current_setting(...), '')::uuid`
 * are NULL, the expression is NULL, and WITH CHECK allows only TRUE. That was
 * confirmed against a real container BEFORE the migration was written, and the
 * migration carries a deliberately different policy because of it. The test at
 * the bottom of this file re-proves the standard shape would have failed, so
 * nobody "simplifies" the migration back to `enableTenantRls()` later.
 *
 * (c) is not a comment-level convention. "A log that the audited service can
 * rewrite is not evidence" (§8.7) — the grant is the mechanism, and this
 * asserts it against information_schema.
 */
describe('audit-service — real PostgreSQL RLS, nullable-org events, append-only grants (§8.7)', () => {
  jest.setTimeout(120_000);

  const db = new PostgresTestContainer();
  const tenantContext = new TenantContextStore();
  const auditRepo = new AuditEventRepository(tenantContext);
  const securityRepo = new SecurityEventRepository(tenantContext);

  beforeAll(async () => {
    await db.start([AuditEvent, SecurityEvent]);
    await db.runMigration(async (qr) => {
      await new CreateAuditAndSecurityEvents1700000000001().up(qr);
      await new CreateConsumedEvents1700000000002().up(qr);
    });
    await db.connectAppDataSource();
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  function contextFor(organizationId: string | null, userId: string, roles: Role[]) {
    return { userId, organizationId, roles, correlationId: 'corr-1', iat: 0, exp: 0 };
  }

  /** Exactly what TenantAwareDataSource.transactionForOrganization() does in production. */
  async function asOrg<T>(
    organizationId: string,
    userId: string,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const runner = db.appDataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query("SELECT set_config('app.current_org', $1, true)", [organizationId]);
      const result = await tenantContext.run(
        contextFor(organizationId, userId, [Role.ORG_ADMIN]),
        () => work(runner.manager),
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

  /**
   * Exactly what TenantAwareDataSource.runGlobal() does: a transaction with NO
   * set_config at all — the platform-admin path, and the only path available to
   * a consumer handling an envelope with no organizationId.
   *
   * Deliberately run on `db.appDataSource`, a connection this suite has already
   * used for scoped transactions, so it exercises the REUSED-connection path
   * where `current_setting('app.current_org', true)` returns the leftover EMPTY
   * STRING rather than NULL (§32.4). The policy's NULLIF(..., '') is what makes
   * that case behave identically to a genuinely-never-scoped connection.
   */
  async function unscoped<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const runner = db.appDataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const result = await tenantContext.run(
        contextFor(null, USER_A, [Role.PLATFORM_ADMIN]),
        () => work(runner.manager),
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

  let orgAAuditId: string;
  let orgBAuditId: string;
  let orgASecurityId: string;
  let platformSecurityId: string;

  beforeEach(async () => {
    // Clearing between tests is TRUNCATE as the OWNER (app_migrator), and both
    // halves of that are forced on us rather than chosen:
    //
    //   - not app_user, because it holds no DELETE on these tables at all —
    //     that is the append-only property this suite asserts further down, so
    //     using it here would be self-contradictory;
    //   - not `DELETE` as the owner either, because both tables have FORCE ROW
    //     LEVEL SECURITY, which applies the policy to the OWNER too. An
    //     unscoped `DELETE FROM audit_events` as app_migrator matches only the
    //     NULL-org rows and silently leaves every tenant's rows in place —
    //     observed directly while writing this file: rows accumulated across
    //     tests until the isolation assertions started counting three org-A
    //     rows instead of one. TRUNCATE is not row-filtered, so it is not
    //     subject to the policy.
    //
    // The fact that FORCE RLS defeats an owner's unscoped DELETE is itself
    // reassuring: it is the same mechanism that makes every assertion below
    // meaningful.
    await db.runMigration(async (qr) => {
      await qr.query('TRUNCATE audit_events, security_events');
    });

    orgAAuditId = await asOrg(ORG_A, USER_A, async (m) => {
      const row = await auditRepo.create(
        {
          eventId: nextEventId(),
          eventType: 'ResourceCreated',
          organizationId: ORG_A,
          actorUserId: USER_A,
          correlationId: 'cccccccc-0000-0000-0000-00000000000a',
          severity: 'info',
          payload: { name: 'org-a-secret.pdf' },
          occurredAt: new Date('2025-01-01T00:00:00.000Z'),
        },
        m,
      );
      return row.id;
    });

    orgBAuditId = await asOrg(ORG_B, USER_B, async (m) => {
      const row = await auditRepo.create(
        {
          eventId: nextEventId(),
          eventType: 'ResourceCreated',
          organizationId: ORG_B,
          actorUserId: USER_B,
          correlationId: 'cccccccc-0000-0000-0000-00000000000b',
          severity: 'info',
          payload: { name: 'org-b-secret.pdf' },
          occurredAt: new Date('2025-01-02T00:00:00.000Z'),
        },
        m,
      );
      return row.id;
    });

    orgASecurityId = await asOrg(ORG_A, USER_A, async (m) => {
      const row = await securityRepo.create(
        {
          eventId: nextEventId(),
          eventType: 'CrossTenantAccessAttempted',
          organizationId: ORG_A,
          actorUserId: USER_A,
          correlationId: 'cccccccc-0000-0000-0000-00000000000c',
          severity: 'security',
          payload: {
            subjectType: 'Resource',
            subjectId: 'dddddddd-0000-0000-0000-000000000001',
            actorOrganizationId: ORG_A,
            actorUserId: USER_A,
          },
          occurredAt: new Date('2025-01-03T00:00:00.000Z'),
        },
        m,
      );
      return row.id;
    });

    // (b): the genuinely org-less event — auth-service's AuthenticationFailed
    // for an email that maps to no credential at all. No organisation exists to
    // attach, because establishing one is precisely what failed.
    platformSecurityId = await unscoped(async (m) => {
      const row = await securityRepo.create(
        {
          eventId: nextEventId(),
          eventType: 'AuthenticationFailed',
          organizationId: null,
          actorUserId: null,
          correlationId: 'cccccccc-0000-0000-0000-00000000000d',
          severity: 'security',
          payload: { email: 'nobody@example.com', reason: 'unknown_email' },
          occurredAt: new Date('2025-01-04T00:00:00.000Z'),
        },
        m,
      );
      return row.id;
    });
  });

  describe('(a) RLS isolation between two orgs (§13.1)', () => {
    it("a raw SELECT * with NO WHERE clause returns only the calling tenant's audit events", async () => {
      const rows = await asOrg(ORG_A, USER_A, (m) =>
        m.query<{ id: string; organization_id: string }[]>('SELECT * FROM audit_events'),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(orgAAuditId);
      expect(rows.map((r) => r.id)).not.toContain(orgBAuditId);
    });

    it('is symmetric — org B sees only org B, not an artefact of seeding order', async () => {
      const rows = await asOrg(ORG_B, USER_B, (m) =>
        m.query<{ id: string }[]>('SELECT * FROM audit_events'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(orgBAuditId);
    });

    it("listPage returns only the calling tenant's audit events, with their payloads", async () => {
      const page = await asOrg(ORG_A, USER_A, (m) => auditRepo.listPage({}, m));

      expect(page.items).toHaveLength(1);
      expect(page.items[0].organizationId).toBe(ORG_A);
      expect(page.items[0].payload).toEqual({ name: 'org-a-secret.pdf' });
    });

    it("security_events are isolated the same way — org A cannot see org B's", async () => {
      const orgBSecurityId = await asOrg(ORG_B, USER_B, async (m) => {
        const row = await securityRepo.create(
          {
            eventId: nextEventId(),
            eventType: 'CrossTenantAccessAttempted',
            organizationId: ORG_B,
            actorUserId: USER_B,
            correlationId: 'cccccccc-0000-0000-0000-00000000000e',
            severity: 'security',
            payload: { subjectType: 'User', subjectId: USER_A },
            occurredAt: new Date('2025-01-05T00:00:00.000Z'),
          },
          m,
        );
        return row.id;
      });

      const asA = await asOrg(ORG_A, USER_A, (m) => securityRepo.listPage({}, m));
      expect(asA.items.map((r) => r.id)).toEqual([orgASecurityId]);
      expect(asA.items.map((r) => r.id)).not.toContain(orgBSecurityId);
    });

    /**
     * WITH CHECK, not just USING. Without it a write could plant a row in
     * another tenant even though it could never be read back — and for an AUDIT
     * table specifically, planting a forged record in another org's trail is a
     * more interesting attack than reading one.
     */
    it("org A cannot INSERT an audit row belonging to org B — WITH CHECK rejects it", async () => {
      await expect(
        asOrg(ORG_A, USER_A, (m) =>
          m.query(
            `INSERT INTO audit_events
               (event_id, event_type, organization_id, correlation_id, severity, payload, occurred_at)
             VALUES (gen_random_uuid(), 'Forged', $1, gen_random_uuid(), 'info', '{}'::jsonb, now())`,
            [ORG_B],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('the create() path cannot be talked into writing another org\'s row either', async () => {
      // The repository takes organizationId from the envelope, so a malformed
      // envelope claiming org B inside an org-A-scoped transaction is exactly
      // the case RLS has the final say on.
      await expect(
        asOrg(ORG_A, USER_A, (m) =>
          auditRepo.create(
            {
              eventId: nextEventId(),
              eventType: 'ResourceCreated',
              organizationId: ORG_B,
              actorUserId: USER_A,
              correlationId: 'cccccccc-0000-0000-0000-00000000000f',
              severity: 'info',
              payload: {},
              occurredAt: new Date(),
            },
            m,
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('(b) the NULLABLE organization_id edge case — the one that needed a different policy', () => {
    /**
     * THE CASE THE STANDARD POLICY SHAPE WOULD HAVE BROKEN. `beforeEach` already
     * wrote this row through `unscoped()`, so reaching this assertion at all
     * proves the insert succeeded. Under `enableTenantRls()`'s shape it would
     * have failed with "new row violates row-level security policy" — making
     * EVERY platform-level AuthenticationFailed event permanently undeliverable,
     * retried three times and dead-lettered, silently disabling the brute-force
     * detection half of §8.7 while the org-scoped half kept working.
     */
    it('an org-LESS security event can be WRITTEN from an unscoped transaction', async () => {
      expect(platformSecurityId).toBeTruthy();
    });

    it('and is READABLE by a platform-admin-scoped (unscoped) read', async () => {
      const rows = await unscoped((m) =>
        m.query<{ id: string; organization_id: string | null; event_type: string }[]>(
          'SELECT * FROM security_events',
        ),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(platformSecurityId);
      expect(rows[0].organization_id).toBeNull();
      expect(rows[0].event_type).toBe('AuthenticationFailed');
    });

    /**
     * The isolation half, and the half that would be a genuine leak if wrong:
     * the extra disjunct in the policy must not make platform-level rows
     * visible to an organisation. An org-scoped read sees its OWN rows and
     * nothing else — not another org's, and not the platform's.
     */
    it('but is INVISIBLE to every org-scoped read', async () => {
      const asA = await asOrg(ORG_A, USER_A, (m) =>
        m.query<{ id: string }[]>('SELECT * FROM security_events'),
      );
      const asB = await asOrg(ORG_B, USER_B, (m) =>
        m.query<{ id: string }[]>('SELECT * FROM security_events'),
      );

      expect(asA.map((r) => r.id)).toEqual([orgASecurityId]);
      expect(asA.map((r) => r.id)).not.toContain(platformSecurityId);
      expect(asB).toHaveLength(0);
    });

    /**
     * The converse, and the property that keeps the wider policy honest: an
     * UNSCOPED transaction still cannot write a row INTO an organisation. The
     * extra disjunct permits NULL-org rows only, never a tenant's.
     */
    it('an unscoped transaction still CANNOT plant a row in an organisation', async () => {
      await expect(
        unscoped((m) =>
          m.query(
            `INSERT INTO security_events
               (event_id, event_type, organization_id, correlation_id, severity, payload, occurred_at)
             VALUES (gen_random_uuid(), 'Forged', $1, gen_random_uuid(), 'security', '{}'::jsonb, now())`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('an org-scoped transaction cannot write a platform-level (NULL-org) row either', async () => {
      await expect(
        asOrg(ORG_A, USER_A, (m) =>
          m.query(
            `INSERT INTO security_events
               (event_id, event_type, organization_id, correlation_id, severity, payload, occurred_at)
             VALUES (gen_random_uuid(), 'Forged', NULL, gen_random_uuid(), 'security', '{}'::jsonb, now())`,
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    /**
     * §32.4's empty-string trap, applied to the new disjunct. `set_config(..., true)`
     * reverts to '' on commit, not NULL, and that persists on a pooled
     * connection — so `NULLIF(..., '')` is what makes "previously scoped, now
     * unscoped" behave identically to "never scoped". Without it, the
     * `... IS NULL` disjunct would never fire on a reused connection and
     * platform-level writes would work on a fresh connection but not a reused
     * one, which is worse than failing consistently.
     */
    it('behaves identically on a REUSED connection carrying a leftover empty-string setting (§32.4)', async () => {
      // Scope, commit, then read unscoped on the same pooled DataSource.
      await asOrg(ORG_A, USER_A, (m) => m.query('SELECT 1'));

      const [setting] = await db.appDataSource.query<{ v: string | null }[]>(
        `SELECT current_setting('app.current_org', true) AS v`,
      );
      // Documents the trap itself: the empty string, not NULL.
      expect(setting.v).toBe('');

      const rows = await db.appDataSource.query<{ id: string }[]>(
        'SELECT * FROM security_events',
      );
      expect(rows.map((r) => r.id)).toEqual([platformSecurityId]);
    });

    /**
     * THE REGRESSION GUARD FOR THE MIGRATION'S DELIBERATE DIFFERENCE. Builds a
     * throwaway table with the STANDARD `enableTenantRls()` policy shape and
     * proves the unscoped NULL-org insert is rejected on it — the empirical
     * finding that justified writing a different policy for these two tables.
     *
     * If this ever starts passing, Postgres's WITH CHECK semantics changed and
     * the migration's special case can be revisited. Until then, this is why
     * `enableTenantRls()` is not called there — and why it must NOT be
     * "simplified" back to it.
     */
    it("re-proves the STANDARD enableTenantRls() policy shape REJECTS this insert — why the migration differs", async () => {
      await db.runMigration(async (qr) => {
        await qr.query(`
          CREATE TABLE "std_policy_probe" (
            "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            "organization_id" uuid
          )
        `);
        await qr.query(`ALTER TABLE "std_policy_probe" ENABLE ROW LEVEL SECURITY`);
        await qr.query(`ALTER TABLE "std_policy_probe" FORCE ROW LEVEL SECURITY`);
        // Verbatim the shape enableTenantRls() applies to every other table.
        await qr.query(`
          CREATE POLICY tenant_isolation ON "std_policy_probe"
            USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
            WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
        `);
        await qr.query(`GRANT SELECT, INSERT ON "std_policy_probe" TO app_user`);
      });

      try {
        await expect(
          unscoped((m) =>
            m.query(`INSERT INTO std_policy_probe (organization_id) VALUES (NULL)`),
          ),
        ).rejects.toThrow(/row-level security/i);

        // And the audit tables' own policy accepts the identical insert — the
        // difference is the policy, not the connection, the role or the schema.
        await expect(
          unscoped((m) =>
            m.query(
              `INSERT INTO security_events
                 (event_id, event_type, organization_id, correlation_id, severity, payload, occurred_at)
               VALUES (gen_random_uuid(), 'AuthenticationFailed', NULL, gen_random_uuid(),
                       'security', '{}'::jsonb, now())`,
            ),
          ),
        ).resolves.not.toThrow();
      } finally {
        await db.runMigration((qr) => qr.query(`DROP TABLE IF EXISTS "std_policy_probe"`));
      }
    });
  });

  describe('(c) append-only at the GRANT level (§8.7)', () => {
    /**
     * "No UPDATE or DELETE is granted to the service's database role" is a real,
     * checkable security property this service depends on — not a code-level
     * convention and not a comment. app_user is the role every audit-service
     * process actually connects as, so this is what stops a bug, a compromised
     * consumer or a deliberately malicious query from rewriting history.
     */
    it('app_user holds exactly SELECT and INSERT on both tables — never UPDATE or DELETE', async () => {
      const grants = await db.appDataSource.query<
        { table_name: string; privilege_type: string }[]
      >(
        `SELECT table_name, privilege_type
           FROM information_schema.table_privileges
          WHERE grantee = 'app_user'
            AND table_name IN ('audit_events', 'security_events')
          ORDER BY table_name, privilege_type`,
      );

      for (const table of ['audit_events', 'security_events']) {
        const privileges = grants
          .filter((g) => g.table_name === table)
          .map((g) => g.privilege_type)
          .sort();

        expect(privileges).toEqual(['INSERT', 'SELECT']);
        // Stated separately so a failure names the actual problem.
        expect(privileges).not.toContain('UPDATE');
        expect(privileges).not.toContain('DELETE');
        expect(privileges).not.toContain('TRUNCATE');
      }
    });

    it('an UPDATE by app_user is refused by the database, not merely absent from the code', async () => {
      await expect(
        asOrg(ORG_A, USER_A, (m) =>
          m.query(`UPDATE audit_events SET event_type = 'Rewritten' WHERE id = $1`, [
            orgAAuditId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('a DELETE by app_user is refused too — an audit row cannot be erased', async () => {
      await expect(
        asOrg(ORG_A, USER_A, (m) =>
          m.query(`DELETE FROM security_events WHERE id = $1`, [orgASecurityId]),
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe('the RLS configuration itself (§13.8 check #1)', () => {
    it('both tables have RLS ENABLED and FORCED, with a policy carrying USING and WITH CHECK', async () => {
      const rows = await db.appDataSource.query<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT relname, relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relname IN ('audit_events', 'security_events')
          ORDER BY relname`,
      );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.relrowsecurity).toBe(true);
        // FORCE makes the policy apply to the OWNER too — without it
        // app_migrator would bypass it silently.
        expect(row.relforcerowsecurity).toBe(true);
      }

      const policies = await db.appDataSource.query<
        { tablename: string; qual: string | null; with_check: string | null }[]
      >(
        `SELECT tablename, qual, with_check
           FROM pg_policies
          WHERE tablename IN ('audit_events', 'security_events')
          ORDER BY tablename`,
      );

      expect(policies).toHaveLength(2);
      for (const policy of policies) {
        expect(policy.qual).toContain('app.current_org');
        expect(policy.with_check).toContain('app.current_org');
        // The nullable-org disjunct this service's tables uniquely need — asserted
        // so a later "simplification" back to enableTenantRls() fails here loudly
        // rather than silently breaking platform-level security events.
        expect(policy.qual).toContain('IS NULL');
        expect(policy.with_check).toContain('IS NULL');
      }
    });

    it('the runtime role is NOT superuser and does NOT have BYPASSRLS', async () => {
      const [role] = await db.appDataSource.query<
        { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
      >(`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);

      // A superuser would void BOTH guarantees this file tests: RLS policies
      // and the append-only table grants.
      expect(role.rolname).toBe('app_user');
      expect(role.rolsuper).toBe(false);
      expect(role.rolbypassrls).toBe(false);
    });

    it('UNIQUE(event_id) makes a replayed event a no-op rather than a duplicate record (§17.6)', async () => {
      const duplicateId = nextEventId();
      const write = () =>
        asOrg(ORG_A, USER_A, (m) =>
          auditRepo.create(
            {
              eventId: duplicateId,
              eventType: 'UserCreated',
              organizationId: ORG_A,
              actorUserId: USER_A,
              correlationId: 'cccccccc-0000-0000-0000-000000000010',
              severity: 'info',
              payload: {},
              occurredAt: new Date('2025-01-06T00:00:00.000Z'),
            },
            m,
          ),
        );

      await write();
      // consumed_events dedupes first in production, but it is marked in a
      // SEPARATE transaction after this one commits — a crash in between
      // replays the event, and this constraint is what catches it.
      await expect(write()).rejects.toThrow(/duplicate key|unique/i);
    });
  });
});
