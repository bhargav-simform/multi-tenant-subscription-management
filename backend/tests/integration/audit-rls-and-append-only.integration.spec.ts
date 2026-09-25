import { randomUUID } from 'node:crypto';
import { clearSubscriptions, publish } from '../../src/lib/events';
import { runGlobal, transactionForOrganization, type Tx } from '../../src/lib/tenant-db';
import * as auditRecords from '../../src/models/audit-record.model';
import type { CreateAuditRecordData } from '../../src/models/audit-record.model';
import * as auditService from '../../src/services/audit.service';
import * as auditSink from '../../src/events/handlers/audit-sink.handler';
import * as securitySink from '../../src/events/handlers/security-events.handler';
import { Role } from '../../src/types/constants';
import { EVENT_TYPES, TOPICS } from '../../src/types/events';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { runAs } from '../support/tenant-fixtures';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/**
 * The audit tables against real PostgreSQL as app_user. Three properties that cannot
 * be verified anywhere else:
 *
 *   (a) RLS isolation between two orgs' audit and security events;
 *   (b) the NULLABLE organization_id edge case — a genuinely org-less security event
 *       (failed login for an unknown email) can be WRITTEN, is readable unscoped, and
 *       is invisible to every org-scoped read. The standard tenant policy REJECTS that
 *       insert (re-proved below), which is why the migration carries a different one;
 *   (c) append-only at the GRANT level — app_user holds SELECT and INSERT only.
 */
describe('audit — real PostgreSQL RLS, nullable-org events, append-only grants', () => {
  const db = new PostgresTestContainer();

  beforeAll(() => db.start());
  afterAll(() => db.stop());

  function event(
    organizationId: string | null,
    overrides: Partial<CreateAuditRecordData> = {},
  ): CreateAuditRecordData {
    return {
      eventId: randomUUID(),
      eventType: 'ResourceCreated',
      organizationId,
      actorUserId: organizationId === ORG_A ? USER_A : organizationId === ORG_B ? USER_B : null,
      correlationId: randomUUID(),
      severity: 'info',
      payload: {},
      occurredAt: new Date('2025-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  const asOrg = <T>(org: string, work: (tx: Tx) => Promise<T>) =>
    transactionForOrganization(org, work);

  let orgAAuditId: string;
  let orgBAuditId: string;
  let orgASecurityId: string;
  let platformSecurityId: string;

  beforeEach(async () => {
    // TRUNCATE as the owner: app_user has no DELETE (the property under test), and an
    // owner's unscoped DELETE would be filtered by FORCE RLS to the NULL-org rows only.
    await db.asMigrator((c) => c.query('TRUNCATE audit_events, security_events'));

    orgAAuditId = (
      await asOrg(ORG_A, (tx) =>
        auditRecords.create(tx, 'audit', event(ORG_A, { payload: { name: 'org-a-secret.pdf' } })),
      )
    ).id;
    orgBAuditId = (
      await asOrg(ORG_B, (tx) =>
        auditRecords.create(
          tx,
          'audit',
          event(ORG_B, {
            payload: { name: 'org-b-secret.pdf' },
            occurredAt: new Date('2025-01-02T00:00:00.000Z'),
          }),
        ),
      )
    ).id;
    orgASecurityId = (
      await asOrg(ORG_A, (tx) =>
        auditRecords.create(
          tx,
          'security',
          event(ORG_A, {
            eventType: 'CrossTenantAccessAttempted',
            severity: 'security',
            payload: { subjectType: 'Resource', subjectId: randomUUID() },
          }),
        ),
      )
    ).id;
    // (b): the genuinely org-less event, written through the service's own path.
    await auditService.record(
      'security',
      event(null, {
        eventType: 'AuthenticationFailed',
        severity: 'security',
        payload: { email: 'nobody@example.com', reason: 'unknown_email' },
        occurredAt: new Date('2025-01-04T00:00:00.000Z'),
      }),
    );
    const [row] = await db
      .asSuperuser((c) =>
        c.query<{ id: string }>('SELECT id FROM security_events WHERE organization_id IS NULL'),
      )
      .then((r) => r.rows);
    platformSecurityId = row.id;
  });

  describe('(a) RLS isolation between two orgs', () => {
    it("a raw SELECT * with NO WHERE clause returns only the calling tenant's audit events", async () => {
      const rows = await asOrg(
        ORG_A,
        (tx) => tx.$queryRaw<{ id: string }[]>`SELECT * FROM audit_events`,
      );
      expect(rows.map((r) => r.id)).toEqual([orgAAuditId]);
    });

    it('is symmetric — org B sees only org B', async () => {
      const rows = await asOrg(
        ORG_B,
        (tx) => tx.$queryRaw<{ id: string }[]>`SELECT * FROM audit_events`,
      );
      expect(rows.map((r) => r.id)).toEqual([orgBAuditId]);
    });

    it("the org-admin listing returns only the caller's events, with payloads", async () => {
      const { page, metadataOnly } = await runAs(ORG_A, USER_A, () =>
        auditService.listAuditEvents({}),
      );
      expect(metadataOnly).toBe(false);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].organizationId).toBe(ORG_A);
      expect(page.items[0].payload).toEqual({ name: 'org-a-secret.pdf' });
    });

    it("security_events are isolated the same way — org A cannot see org B's", async () => {
      const orgBSecurityId = (
        await asOrg(ORG_B, (tx) =>
          auditRecords.create(tx, 'security', event(ORG_B, { severity: 'security' })),
        )
      ).id;
      const asA = await asOrg(ORG_A, (tx) => auditRecords.listPage(tx, 'security', {}, ORG_A));
      expect(asA.items.map((r) => r.id)).toEqual([orgASecurityId]);
      expect(asA.items.map((r) => r.id)).not.toContain(orgBSecurityId);
    });

    it('org A cannot INSERT an audit row belonging to org B — WITH CHECK rejects it', async () => {
      await expect(
        asOrg(
          ORG_A,
          (tx) => tx.$executeRaw`
            INSERT INTO audit_events
              (event_id, event_type, organization_id, correlation_id, severity, payload, occurred_at)
            VALUES (gen_random_uuid(), 'Forged', ${ORG_B}::uuid, gen_random_uuid(), 'info', '{}'::jsonb, now())`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("the create() path cannot be talked into writing another org's row either", async () => {
      await expect(
        asOrg(ORG_A, (tx) => auditRecords.create(tx, 'audit', event(ORG_B))),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('(b) the NULLABLE organization_id edge case', () => {
    it('an org-LESS security event can be WRITTEN from an unscoped transaction', () => {
      // beforeEach wrote it through auditService.record(); reaching here proves it.
      expect(platformSecurityId).toBeTruthy();
    });

    it('and is READABLE by an unscoped (platform-admin) read', async () => {
      const rows = await runGlobal(
        (tx) =>
          tx.$queryRaw<{ id: string; organization_id: string | null; event_type: string }[]>`
          SELECT * FROM security_events`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: platformSecurityId,
        organization_id: null,
        event_type: 'AuthenticationFailed',
      });

      const page = await runAs(null, USER_A, () => auditService.listSecurityEvents({}), [
        Role.PLATFORM_ADMIN,
      ]);
      expect(page.items.map((r) => r.id)).toEqual([platformSecurityId]);
    });

    it('but is INVISIBLE to every org-scoped read', async () => {
      const asA = await asOrg(
        ORG_A,
        (tx) => tx.$queryRaw<{ id: string }[]>`SELECT * FROM security_events`,
      );
      const asB = await asOrg(
        ORG_B,
        (tx) => tx.$queryRaw<{ id: string }[]>`SELECT * FROM security_events`,
      );
      expect(asA.map((r) => r.id)).toEqual([orgASecurityId]);
      expect(asB).toHaveLength(0);
    });

    it('an unscoped transaction still CANNOT plant a row in an organisation', async () => {
      await expect(
        runGlobal((tx) => auditRecords.create(tx, 'security', event(ORG_A))),
      ).rejects.toThrow(/row-level security/i);
    });

    it('an org-scoped transaction cannot write a platform-level (NULL-org) row either', async () => {
      await expect(
        asOrg(ORG_A, (tx) => auditRecords.create(tx, 'security', event(null))),
      ).rejects.toThrow(/row-level security/i);
    });

    it('behaves identically on a REUSED connection carrying the leftover empty-string setting', async () => {
      await db.asAppUser(async (c) => {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.current_org', $1, true)", [ORG_A]);
        await c.query('COMMIT');
        const setting = await c.query("SELECT current_setting('app.current_org', true) AS v");
        // The trap itself: '' not NULL.
        expect(setting.rows[0].v).toBe('');

        const rows = await c.query<{ id: string }>('SELECT id FROM security_events');
        expect(rows.rows.map((r) => r.id)).toEqual([platformSecurityId]);
      });
    });

    it('the platform-admin audit listing sees only NULL-org rows and is metadata-only', async () => {
      await auditService.record('audit', event(null, { eventType: 'OnboardingFailed' }));
      const { page, metadataOnly } = await runAs(
        null,
        USER_A,
        () => auditService.listAuditEvents({}),
        [Role.PLATFORM_ADMIN],
      );
      expect(metadataOnly).toBe(true);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].organizationId).toBeNull();
    });

    /**
     * Regression guard for the migration's deliberate difference: a throwaway table with
     * the STANDARD tenant policy rejects the identical unscoped NULL-org insert. If this
     * ever stops failing, the special case can be revisited; until then do not
     * "simplify" the audit policy back to the standard one.
     */
    it('re-proves the STANDARD tenant policy REJECTS this insert — why the migration differs', async () => {
      await db.asMigrator(async (c) => {
        await c.query(`CREATE TABLE std_policy_probe (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid)`);
        await c.query('ALTER TABLE std_policy_probe ENABLE ROW LEVEL SECURITY');
        await c.query('ALTER TABLE std_policy_probe FORCE ROW LEVEL SECURITY');
        // Verbatim the shape the migration applies to every other tenant table.
        await c.query(`CREATE POLICY tenant_isolation ON std_policy_probe
          USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
          WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)`);
        await c.query('GRANT SELECT, INSERT ON std_policy_probe TO app_user');
      });

      try {
        await expect(
          runGlobal(
            (tx) => tx.$executeRaw`INSERT INTO std_policy_probe (organization_id) VALUES (NULL)`,
          ),
        ).rejects.toThrow(/row-level security/i);

        // The audit tables' own policy accepts the identical insert.
        await expect(
          runGlobal(
            (tx) => tx.$executeRaw`
              INSERT INTO security_events
                (event_id, event_type, organization_id, correlation_id, severity, payload, occurred_at)
              VALUES (gen_random_uuid(), 'AuthenticationFailed', NULL, gen_random_uuid(),
                      'security', '{}'::jsonb, now())`,
          ),
        ).resolves.toBe(1);
      } finally {
        await db.asMigrator((c) => c.query('DROP TABLE IF EXISTS std_policy_probe'));
      }
    });
  });

  describe('(c) append-only at the GRANT level', () => {
    it('app_user holds exactly SELECT and INSERT on both tables — never UPDATE, DELETE or TRUNCATE', async () => {
      const grants = await db.prisma.$queryRaw<{ table_name: string; privilege_type: string }[]>`
        SELECT table_name, privilege_type FROM information_schema.table_privileges
         WHERE grantee = 'app_user' AND table_name IN ('audit_events', 'security_events')
         ORDER BY table_name, privilege_type`;

      for (const table of ['audit_events', 'security_events']) {
        const privileges = grants
          .filter((g) => g.table_name === table)
          .map((g) => g.privilege_type)
          .sort();
        expect(privileges).toEqual(['INSERT', 'SELECT']);
      }
    });

    it('an UPDATE by app_user is refused by the database, not merely absent from the code', async () => {
      await expect(
        asOrg(
          ORG_A,
          (tx) =>
            tx.$executeRaw`UPDATE audit_events SET event_type = 'Rewritten' WHERE id = ${orgAAuditId}::uuid`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('a DELETE by app_user is refused too — an audit row cannot be erased', async () => {
      await expect(
        asOrg(
          ORG_A,
          (tx) => tx.$executeRaw`DELETE FROM security_events WHERE id = ${orgASecurityId}::uuid`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('a TRUNCATE by app_user is refused as well', async () => {
      await expect(runGlobal((tx) => tx.$executeRaw`TRUNCATE audit_events`)).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  describe('the RLS configuration itself', () => {
    it('both tables have RLS ENABLED and FORCED, with the NULL-org disjunct in USING and WITH CHECK', async () => {
      const rows = await db.prisma.$queryRaw<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname IN ('audit_events', 'security_events') ORDER BY relname`;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }

      const policies = await db.prisma.$queryRaw<
        { qual: string | null; with_check: string | null }[]
      >`SELECT qual, with_check FROM pg_policies
         WHERE tablename IN ('audit_events', 'security_events')`;
      expect(policies).toHaveLength(2);
      for (const policy of policies) {
        expect(policy.qual).toContain('app.current_org');
        expect(policy.with_check).toContain('app.current_org');
        // The nullable-org disjunct these tables uniquely need.
        expect(policy.qual).toContain('IS NULL');
        expect(policy.with_check).toContain('IS NULL');
      }
    });

    it('the runtime role is NOT superuser and does NOT have BYPASSRLS', async () => {
      const [role] = await db.prisma.$queryRaw<
        { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
      >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      // A superuser would void BOTH guarantees: RLS and the append-only grants.
      expect(role).toEqual({ rolname: 'app_user', rolsuper: false, rolbypassrls: false });
    });

    it('UNIQUE(event_id) makes a replayed event a rejected duplicate, not a second record', async () => {
      const data = event(ORG_A, { eventType: 'UserCreated' });
      await asOrg(ORG_A, (tx) => auditRecords.create(tx, 'audit', data));
      await expect(asOrg(ORG_A, (tx) => auditRecords.create(tx, 'audit', data))).rejects.toThrow(
        /uq_audit_events_event_id|Unique constraint/i,
      );
    });

    it('ck_*_severity rejects an unknown severity', async () => {
      await expect(
        asOrg(ORG_A, (tx) =>
          auditRecords.create(tx, 'audit', event(ORG_A, { severity: 'debug' as 'info' })),
        ),
      ).rejects.toThrow(/ck_audit_events_severity/);
    });
  });

  describe('the event-bus sinks write through the same policies', () => {
    beforeAll(() => {
      auditSink.register();
      securitySink.register();
    });
    afterAll(() => clearSubscriptions());

    it('a content event lands in audit_events under its own org, verbatim', async () => {
      await runAs(ORG_A, USER_A, () =>
        publish(TOPICS.RESOURCE, {
          eventType: EVENT_TYPES.RESOURCE_CREATED,
          organizationId: ORG_A,
          actorUserId: USER_A,
          payload: { resourceId: 'r1', name: 'via-bus.pdf', sizeDelta: 5 },
        }),
      );
      const page = await asOrg(ORG_A, (tx) => auditRecords.listPage(tx, 'audit', {}, ORG_A));
      const row = page.items.find((r) => r.payload.name === 'via-bus.pdf');
      expect(row).toMatchObject({
        severity: 'info',
        actorUserId: USER_A,
        eventType: 'ResourceCreated',
      });
    });

    it('PlanLimitExceeded is recorded at warn severity; security events at security', async () => {
      await publish(TOPICS.SUBSCRIPTION, {
        eventType: EVENT_TYPES.PLAN_LIMIT_EXCEEDED,
        organizationId: ORG_B,
        actorUserId: null,
        payload: {},
      });
      await publish(TOPICS.SECURITY, {
        eventType: EVENT_TYPES.AUTHENTICATION_FAILED,
        organizationId: null,
        actorUserId: null,
        payload: { email: 'x@example.com', reason: 'unknown_email' },
      });
      const b = await asOrg(ORG_B, (tx) =>
        auditRecords.listPage(tx, 'audit', { eventType: 'PlanLimitExceeded' }, ORG_B),
      );
      expect(b.items.map((r) => r.severity)).toEqual(['warn']);
      const platform = await runGlobal((tx) => auditRecords.listPage(tx, 'security', {}, null));
      expect(platform.items.every((r) => r.organizationId === null)).toBe(true);
      expect(platform.items.map((r) => r.severity)).toEqual(['security', 'security']);
    });
  });
});
