import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { enableTenantRls, TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { UsageService } from '../../../apps/subscription-service/src/usage/usage.service';

/**
 * §13.6, §32.4 — regression test for a severe, previously-undetected bug in
 * ALREADY-COMMITTED code: `subs.get_usage_aggregates`, the SECURITY DEFINER
 * function `UsageService.getAggregates` depends on for the platform-admin
 * usage view, has always returned ZERO ROWS in production for every
 * organisation — the exact failure mode its own doc comment claimed this
 * function fixed.
 *
 * Root cause: identical to user-service's `get_user_organization_id` bug
 * (see that service's security-definer-bypass.integration.spec.ts) — FORCE
 * ROW LEVEL SECURITY on `subs.subscriptions` applies its policy to the
 * table owner too, and a SECURITY DEFINER function's effective owner during
 * execution IS that owner. A function owned by app_migrator (NOBYPASSRLS)
 * gets no RLS bypass inside it. Nothing had ever exercised this function
 * against a real Postgres container — the original "empirically
 * re-verified" claim in this codebase's history must have used a
 * differently-privileged role than the real app_migrator/app_user pair.
 *
 * Fixed by transferring ownership to `app_rls_bypass` in migration
 * 1700000000004. This test builds the minimal real shape of `subs.plans` and
 * `subs.subscriptions` (as user-service's and subscription-service's actual
 * migrations create/extend them) and exercises the REAL
 * `UsageService.getAggregates` production code path against a REAL Postgres
 * container.
 */
describe('subs.get_usage_aggregates — SECURITY DEFINER genuinely bypasses FORCE RLS (§32.4)', () => {
  jest.setTimeout(120_000);

  const db = new PostgresTestContainer();
  const ORG_A = randomUUID();
  const ORG_B = randomUUID();

  let tenantAwareDataSource: TenantAwareDataSource;
  let usageService: UsageService;

  beforeAll(async () => {
    await db.start([], 'subs');

    await db.runMigration(async (qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS subs`);

      await qr.query(`CREATE TYPE "subs"."plans_code_enum" AS ENUM ('free', 'pro', 'enterprise')`);
      await qr.query(`
        CREATE TABLE "subs"."plans" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "code" "subs"."plans_code_enum" NOT NULL,
          "name" varchar(255) NOT NULL,
          "max_users" int NOT NULL,
          "max_storage_bytes" bigint NOT NULL,
          "is_active" boolean NOT NULL DEFAULT true,
          CONSTRAINT "uq_plans_code" UNIQUE ("code")
        )
      `);
      const [{ id: freePlanId }] = (await qr.query(`
        INSERT INTO "subs"."plans" (code, name, max_users, max_storage_bytes, is_active)
        VALUES ('free', 'Free', 5, 5368709120, true)
        RETURNING id
      `)) as { id: string }[];

      await qr.query(`CREATE TYPE "subs"."subscriptions_status_enum" AS ENUM ('active', 'cancelled')`);
      await qr.query(`
        CREATE TABLE "subs"."subscriptions" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "organization_id" uuid NOT NULL UNIQUE,
          "plan_id" uuid NOT NULL REFERENCES "subs"."plans"("id"),
          "status" "subs"."subscriptions_status_enum" NOT NULL DEFAULT 'active',
          "used_seats" int NOT NULL DEFAULT 0,
          "used_storage_bytes" bigint NOT NULL DEFAULT 0,
          "max_seats_snapshot" int NOT NULL,
          "max_storage_snapshot" bigint NOT NULL,
          "current_period_end" timestamptz,
          "version" int NOT NULL DEFAULT 0,
          "created_at" timestamptz NOT NULL DEFAULT now(),
          "updated_at" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT "ck_subscriptions_seats" CHECK ("used_seats" <= "max_seats_snapshot"),
          CONSTRAINT "ck_subscriptions_storage" CHECK ("used_storage_bytes" <= "max_storage_snapshot")
        )
      `);
      await enableTenantRls(qr, 'subs.subscriptions');

      // Each org's row must be inserted under its OWN scope — WITH CHECK
      // (§13.5) rejects a single unscoped statement trying to plant rows for
      // two different organisations at once, same as it would in production.
      for (const [org, usedSeats] of [
        [ORG_A, 2],
        [ORG_B, 4],
      ] as const) {
        await qr.query(`SELECT set_config('app.current_org', $1, false)`, [org]);
        await qr.query(
          `INSERT INTO "subs"."subscriptions"
             (organization_id, plan_id, used_seats, max_seats_snapshot, max_storage_snapshot)
           VALUES ($1, $2, $3, 5, 5368709120)`,
          [org, freePlanId, usedSeats],
        );
      }
      await qr.query(`SELECT set_config('app.current_org', '', false)`);

      // Mirrors CreatePlansAndExtendSubscriptions's function exactly.
      await qr.query(`
        CREATE FUNCTION "subs"."get_usage_aggregates"(p_organization_id uuid DEFAULT NULL)
        RETURNS TABLE (
          organization_id uuid,
          plan_code "subs"."plans_code_enum",
          used_seats int,
          max_seats int,
          used_storage_bytes bigint,
          max_storage_bytes bigint
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = subs, pg_temp
        AS $$
          SELECT
            sub.organization_id,
            plan.code,
            sub.used_seats,
            sub.max_seats_snapshot,
            sub.used_storage_bytes,
            sub.max_storage_snapshot
          FROM subs.subscriptions sub
          JOIN subs.plans plan ON plan.id = sub.plan_id
          WHERE p_organization_id IS NULL OR sub.organization_id = p_organization_id;
        $$
      `);
      await qr.query(`REVOKE ALL ON FUNCTION "subs"."get_usage_aggregates"(uuid) FROM PUBLIC`);
      await qr.query(`GRANT EXECUTE ON FUNCTION "subs"."get_usage_aggregates"(uuid) TO app_user`);

      // The fix under test: mirrors migration 1700000000004's ownership
      // transfer.
      await qr.query(`GRANT ALL ON SCHEMA "subs" TO app_rls_bypass`);
      await qr.query(`ALTER FUNCTION "subs"."get_usage_aggregates"(uuid) OWNER TO app_rls_bypass`);
      await qr.query(`GRANT SELECT ON "subs"."subscriptions" TO app_rls_bypass`);
      await qr.query(`GRANT SELECT ON "subs"."plans" TO app_rls_bypass`);
    });
    await db.grantAppUserAccessToSchema('subs');
    await db.connectAppDataSource();

    const tenantContext = new TenantContextStore();
    tenantAwareDataSource = new TenantAwareDataSource(db.appDataSource, tenantContext);
    usageService = new UsageService(tenantAwareDataSource);

    // Establishes the reused-connection precondition (§32.4) before the
    // assertions run — a prior scoped transaction, same pool.
    await tenantAwareDataSource.transactionForOrganization(ORG_A, (manager) =>
      manager.query('SELECT 1'),
    );
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  it('returns the FULL cross-org aggregate, not zero rows — the platform-admin usage view', async () => {
    const rows = await usageService.getAggregates();
    expect(rows).toHaveLength(2);

    const byOrg = new Map(rows.map((r) => [r.organizationId, r]));
    expect(byOrg.get(ORG_A)?.usedSeats).toBe(2);
    expect(byOrg.get(ORG_B)?.usedSeats).toBe(4);
  });

  it('a single-org filter returns exactly that org\'s row, not zero rows', async () => {
    const rows = await usageService.getAggregates(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(ORG_A);
    expect(rows[0].usedSeats).toBe(2);
  });
});
