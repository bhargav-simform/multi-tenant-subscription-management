import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §8.7: audit-service owns `audit_db` outright (§14.1) — nothing else migrates
 * these tables, and they live in the default `public` schema (so no
 * schema-qualified identifiers here and no `schema:` option on this service's
 * DataSource, exactly like auth-service, tenant-service and resource-service).
 *
 * Both tenant tables are created AND RLS-protected in THIS SINGLE migration
 * (§13.5, §13.7 row 3). A follow-up migration would leave a window where the
 * table exists unprotected.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THE RLS POLICY BELOW IS WRITTEN OUT BY HAND INSTEAD OF CALLING
 * `enableTenantRls()` — AND WHY THE SHARED HELPER MUST NOT BE CHANGED TO MATCH
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Every other tenant table in this system has `organization_id uuid NOT NULL`.
 * These two do not: a platform-level security event has no organisation. The
 * concrete case is auth-service's `publishAuthFailure`, which publishes
 * `AuthenticationFailed` with `organizationId: null` when a login fails for an
 * email that maps to no credential at all — there is no org context to attach,
 * because establishing one is precisely what failed.
 *
 * `enableTenantRls()`'s policy is
 *
 *     organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
 *
 * For a row with `organization_id IS NULL` written from an UNSCOPED transaction
 * (which is what `TenantAwareDataSource.runGlobal()` gives, and the only kind
 * available when the envelope carries no organisation), both sides are NULL, so
 * the expression evaluates to NULL — and `WITH CHECK` ALLOWS only rows for which
 * it evaluates TRUE, rejecting NULL exactly as it rejects FALSE.
 *
 * VERIFIED EMPIRICALLY against a real Postgres 17 container as the real
 * `app_user` role (NOSUPERUSER, NOBYPASSRLS, non-owner), not assumed, before
 * this migration was written. With the standard policy shape:
 *
 *     INSERT INTO t_std (organization_id, ...) VALUES (NULL, ...)   -- unscoped
 *     ERROR: new row violates row-level security policy for table "t_std"
 *
 * That is not a theoretical edge case: it would make every platform-level
 * `AuthenticationFailed` event PERMANENTLY undeliverable. The consumer would
 * throw, retry three times, and dead-letter every single one — silently
 * disabling the brute-force detection half of §8.7's whole purpose, while the
 * org-scoped half kept working and made the service look healthy.
 *
 * The policy below adds one disjunct: a NULL-org row is visible/writable
 * exactly when NO org scope is set. The same container run confirmed all four
 * behaviours that matter:
 *
 *   unscoped INSERT org=NULL          -> ALLOWED   (the case the standard shape broke)
 *   unscoped INSERT org=<org A>       -> REJECTED  (still cannot plant a row in a tenant)
 *   scoped(A) SELECT                  -> sees org A's rows ONLY, never the NULL-org rows
 *   unscoped SELECT (reused conn)     -> sees the NULL-org rows ONLY, never any tenant's
 *
 * The third line is the one that matters for isolation and is unchanged from
 * every other table: an org-scoped read still cannot see another org's rows,
 * and now additionally cannot see platform-level rows — matching how every
 * other nullable-org-id case in this codebase behaves, and matching §13.6's
 * "platform admin content is structurally separate".
 *
 * `enableTenantRls()` ITSELF IS DELIBERATELY NOT MODIFIED. Every other table's
 * `organization_id` is NOT NULL, so the extra disjunct could never fire for
 * them — but it would still be a widening of the single most load-bearing
 * predicate in the architecture, applied to tables that never asked for it, to
 * serve two tables that can carry their own policy. The narrow, local,
 * commented exception is the reviewable one.
 *
 * NOTE the `true` second argument to `current_setting` and the `NULLIF(..., '')`
 * wrapper are both preserved verbatim from the helper, for the reasons §32.4
 * records: `set_config(..., true)` reverts to the EMPTY STRING on commit, not to
 * NULL, and that empty string persists on a pooled connection. Without the
 * NULLIF, `''::uuid` RAISES on every reused connection — and here it would
 * additionally make the `organization_id IS NULL AND ... IS NULL` disjunct never
 * fire, so the empty-string bug would resurface as "platform-level events can be
 * written on a fresh connection but not a reused one", which is worse than a
 * consistent failure.
 */
export class CreateAuditAndSecurityEvents1700000000001 implements MigrationInterface {
  name = 'CreateAuditAndSecurityEvents1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['audit_events', 'security_events']) {
      await queryRunner.query(`
        CREATE TABLE "${table}" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "event_id" uuid NOT NULL,
          "event_type" varchar(100) NOT NULL,
          "organization_id" uuid,
          "actor_user_id" uuid,
          "correlation_id" uuid NOT NULL,
          "severity" varchar(16) NOT NULL,
          "payload" jsonb NOT NULL,
          "occurred_at" timestamptz NOT NULL,
          "created_at" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT "uq_${table}_event_id" UNIQUE ("event_id"),
          CONSTRAINT "ck_${table}_severity"
            CHECK ("severity" IN ('info', 'warn', 'security'))
        )
      `);

      // §13.5 — ENABLE + FORCE + a policy with BOTH USING and WITH CHECK, in
      // the same migration that creates the table. FORCE is what makes the
      // policy apply to the table OWNER (app_migrator) too; WITH CHECK is what
      // stops a write planting a row in another tenant. See the file header for
      // why this is written out rather than delegated to enableTenantRls().
      await queryRunner.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON "${table}"
          USING (
            organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
            OR (
              organization_id IS NULL
              AND NULLIF(current_setting('app.current_org', true), '') IS NULL
            )
          )
          WITH CHECK (
            organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
            OR (
              organization_id IS NULL
              AND NULLIF(current_setting('app.current_org', true), '') IS NULL
            )
          )
      `);

      // §14.4's two named indexes for this table, verbatim: the list index
      // LEADS with organization_id (serving both the RLS predicate and the
      // ORDER BY), and correlation_id stands alone for trace reconstruction
      // across services — a trace deliberately spans organisations' boundaries
      // only in the sense that one correlation id belongs to one request, so it
      // is not an org-leading lookup.
      await queryRunner.query(`
        CREATE INDEX "idx_${table}_org_occurred"
          ON "${table}" ("organization_id", "occurred_at" DESC, "id")
      `);
      await queryRunner.query(`
        CREATE INDEX "idx_${table}_correlation"
          ON "${table}" ("correlation_id")
      `);

      // §8.7, AND THE POINT OF THIS SERVICE: "no UPDATE or DELETE is granted to
      // the service's database role". This is the append-only guarantee at the
      // DATABASE-GRANT level, not a code convention — `app_user` is the role
      // every audit-service process actually connects as, so even a bug, a
      // compromised consumer, or a deliberately malicious query cannot rewrite
      // or erase an audit record. Contrast resource-service's migration, which
      // grants SELECT, INSERT, UPDATE, DELETE on `resources`.
      //
      // DO NOT ADD UPDATE OR DELETE HERE. "A log that the audited service can
      // rewrite is not evidence" (§8.7). The integration suite asserts this
      // grant set against information_schema, so a later migration that widened
      // it would fail the build rather than quietly void the guarantee.
      await queryRunner.query(`GRANT SELECT, INSERT ON "${table}" TO app_user`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Indexes and policies are dropped implicitly with the table; naming them
    // here would only add ways for this to fail. Order is irrelevant — there are
    // no foreign keys between these two tables (an audit sink deliberately holds
    // no references into anything, including itself).
    await queryRunner.query(`DROP TABLE IF EXISTS "security_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_events"`);
  }
}
