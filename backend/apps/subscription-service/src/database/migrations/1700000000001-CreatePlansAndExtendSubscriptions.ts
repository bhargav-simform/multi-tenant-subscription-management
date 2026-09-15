import { MigrationInterface, QueryRunner } from 'typeorm';
import { enableTenantRls } from '@app/database';

/**
 * §14.2, §32.3 "Migration sequencing for core_db": `subs.subscriptions`
 * already exists — created by user-service's migration, minimally shaped
 * (id, organization_id, used_seats, max_seats_snapshot, plus the seat CHECK)
 * so its concurrency tests could run against a real row before this service
 * existed. This migration EXTENDS that table via ALTER TABLE — it does NOT
 * CREATE TABLE, DROP, or recreate it. Two services migrating one physical
 * table is the direct, honest consequence of §14.2's shared-database
 * decision, not an oversight.
 *
 * `plans` is a fresh, fully-owned GLOBAL table (§13.8) — no RLS, no
 * organization_id, a shared catalogue every organisation reads.
 * `subscription_history` is a fresh, fully-owned TENANT table — no
 * cross-migration dependency.
 */
export class CreatePlansAndExtendSubscriptions1700000000001 implements MigrationInterface {
  name = 'CreatePlansAndExtendSubscriptions1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── subs.plans (§8.5, GLOBAL, no RLS) ───────────────────────────────
    await queryRunner.query(`
      CREATE TYPE "subs"."plans_code_enum" AS ENUM ('free', 'pro', 'enterprise')
    `);
    await queryRunner.query(`
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

    // §22.3 seed data / §27.3: the three plans referenced throughout the
    // architecture doc (free/pro/enterprise), so a fresh `docker compose up`
    // has a usable catalogue with no manual step (brief §6's requirement).
    await queryRunner.query(`
      INSERT INTO "subs"."plans" (code, name, max_users, max_storage_bytes, is_active) VALUES
        ('free',       'Free',       5,   5368709120,   true),
        ('pro',        'Pro',        25,  53687091200,  true),
        ('enterprise', 'Enterprise', 250, 536870912000, true)
    `);

    // ── ALTER subs.subscriptions — extend, never recreate (§32.3) ───────
    await queryRunner.query(`
      CREATE TYPE "subs"."subscriptions_status_enum" AS ENUM ('active', 'cancelled')
    `);
    await queryRunner.query(`
      ALTER TABLE "subs"."subscriptions"
        ADD COLUMN "plan_id" uuid,
        ADD COLUMN "status" "subs"."subscriptions_status_enum" NOT NULL DEFAULT 'active',
        ADD COLUMN "used_storage_bytes" bigint NOT NULL DEFAULT 0,
        ADD COLUMN "max_storage_snapshot" bigint,
        ADD COLUMN "current_period_end" timestamptz,
        ADD COLUMN "version" int NOT NULL DEFAULT 0,
        ADD COLUMN "created_at" timestamptz NOT NULL DEFAULT now(),
        ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now()
    `);
    // plan_id and max_storage_snapshot have no default and no existing rows
    // to backfill (no organisation has onboarded yet at this point in the
    // build), so NOT NULL is added as a separate step rather than inline —
    // this ordering is what lets the ADD COLUMN above succeed on an empty
    // table and still end up with the right constraint.
    await queryRunner.query(`
      ALTER TABLE "subs"."subscriptions"
        ALTER COLUMN "plan_id" SET NOT NULL,
        ALTER COLUMN "max_storage_snapshot" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "subs"."subscriptions"
        ADD CONSTRAINT "fk_subscriptions_plan" FOREIGN KEY ("plan_id") REFERENCES "subs"."plans"("id")
    `);
    // §19.4's second CHECK — storage, alongside the seat CHECK user-service's
    // migration already created.
    await queryRunner.query(`
      ALTER TABLE "subs"."subscriptions"
        ADD CONSTRAINT "ck_subscriptions_storage" CHECK ("used_storage_bytes" <= "max_storage_snapshot"),
        ADD CONSTRAINT "ck_subscriptions_storage_nonneg" CHECK ("used_storage_bytes" >= 0)
    `);

    // ── subs.subscription_history (§8.5, RLS: yes, fully owned) ─────────
    await queryRunner.query(`
      CREATE TABLE "subs"."subscription_history" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "from_plan_id" uuid,
        "to_plan_id" uuid NOT NULL REFERENCES "subs"."plans"("id"),
        "changed_by" uuid NOT NULL,
        "changed_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz
      )
    `);
    await enableTenantRls(queryRunner, 'subs.subscription_history');
    await queryRunner.query(`
      CREATE INDEX "idx_subscription_history_org_changed"
        ON "subs"."subscription_history" ("organization_id", "changed_at" DESC)
    `);

    // §14.2: subscription-service's role needs full access to the tables it
    // fully owns (plans, subscription_history) and to the columns it added
    // to subscriptions. user-service's migration already granted
    // SELECT/UPDATE on subscriptions — that promise describes what
    // USER-SERVICE needs (§14.2's "the single narrowly-scoped grant"), not a
    // ceiling on subscription-service, which OWNS this row and genuinely
    // creates it (assignDefaultPlan, §30.1's SUBSCRIBED step — before that
    // call, no row exists for the organisation at all). Both services
    // connect as the same app_user (§14.2), so this INSERT grant is
    // additive at the role level; which code path actually uses which verb
    // stays scoped by which repository issues which SQL.
    await queryRunner.query(`GRANT INSERT ON "subs"."subscriptions" TO app_user`);
    await queryRunner.query(`GRANT SELECT ON "subs"."plans" TO app_user`);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "subs"."subscription_history" TO app_user`,
    );

    // §8.5, §13.6, R9: GET /internal/usage/aggregate needs a genuine
    // cross-tenant SET read — every organisation's usage, for platform
    // admins. With RLS FORCED on subs.subscriptions, an ordinary app_user
    // query with app.current_org unset returns ZERO rows, not all rows
    // (confirmed: RLS's USING predicate evaluates to NULL, not TRUE, when
    // the setting is unset — NULL filters a row out exactly like FALSE
    // does). There is no way to "just query" this table for all
    // organisations through the normal path, matching the exact reasoning
    // that motivated users.get_user_organization_id() in user-service.
    //
    // This function is the second instance of that same narrow-exception
    // shape (§13.6): SECURITY DEFINER, owned by app_migrator, exposing
    // ONLY the integer/enum columns this one endpoint needs — organisation
    // NAMES or CONTENT are not in this table at all (§8.3 keeps those in
    // tenant_db), so there is no column here this function could leak even
    // if misused. Optional p_organization_id narrows to one org (used when
    // a platform admin — or a future authenticated org admin path — asks
    // for a single organisation's aggregate rather than the full list).
    await queryRunner.query(`
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
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION "subs"."get_usage_aggregates"(uuid) FROM PUBLIC
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION "subs"."get_usage_aggregates"(uuid) TO app_user
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION "subs"."get_usage_aggregates"(uuid)`);
    await queryRunner.query(`DROP TABLE "subs"."subscription_history"`);
    await queryRunner.query(`
      ALTER TABLE "subs"."subscriptions"
        DROP CONSTRAINT "ck_subscriptions_storage",
        DROP CONSTRAINT "ck_subscriptions_storage_nonneg",
        DROP CONSTRAINT "fk_subscriptions_plan"
    `);
    await queryRunner.query(`
      ALTER TABLE "subs"."subscriptions"
        DROP COLUMN "plan_id",
        DROP COLUMN "status",
        DROP COLUMN "used_storage_bytes",
        DROP COLUMN "max_storage_snapshot",
        DROP COLUMN "current_period_end",
        DROP COLUMN "version",
        DROP COLUMN "created_at",
        DROP COLUMN "updated_at"
    `);
    await queryRunner.query(`DROP TYPE "subs"."subscriptions_status_enum"`);
    await queryRunner.query(`DROP TABLE "subs"."plans"`);
    await queryRunner.query(`DROP TYPE "subs"."plans_code_enum"`);
  }
}
