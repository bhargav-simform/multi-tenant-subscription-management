import { MigrationInterface, QueryRunner } from 'typeorm';
import { enableTenantRls } from '@app/database';

/**
 * §8.6: resource-service owns `resource_db` outright (§14.1) — unlike
 * core_db's two services, nothing else migrates these tables, and they live
 * in the default `public` schema (so no schema-qualified identifiers and no
 * `schema:` option on this service's DataSource).
 *
 * BOTH tenant tables are created AND RLS-protected in THIS SINGLE migration
 * (§13.5, §13.7 row 3): a follow-up migration would leave a window where the
 * table exists unprotected, which is the one genuine leak this codebase's
 * tenant-isolation rules exist to prevent.
 */
export class CreateResourcesAndPlanLimitCache1700000000001 implements MigrationInterface {
  name = 'CreateResourcesAndPlanLimitCache1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── resources (§8.6, RLS: yes) ──────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "resources" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "size_bytes" bigint NOT NULL,
        "created_by" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "ck_resources_size_nonneg" CHECK ("size_bytes" >= 0)
      )
    `);
    await enableTenantRls(queryRunner, 'resources');

    // §14.4: the index LEADS with organization_id, then the keyset pagination
    // ordering columns (created_at DESC, id) — this is the exact shape
    // ResourceRepository.listPage's ORDER BY and cursor predicate use.
    await queryRunner.query(`
      CREATE INDEX "idx_resources_org_created"
        ON "resources" ("organization_id", "created_at" DESC, "id")
    `);

    // §13.6, §13.9, §32.4: the cross-tenant DETECTION probe cannot be a plain
    // unscoped query, even via runGlobal() — `resources` is FORCE-protected,
    // so a query with app.current_org unset (NULL, correctly, after the
    // NULLIF fix — see enableTenantRls's doc comment) has its USING policy
    // evaluate `organization_id = NULL`, which is unknown/false for EVERY
    // row, not just a foreign one. An unscoped SELECT can never see ANY
    // resource this way, so it can never distinguish "exists in another org"
    // from "does not exist" — the exact distinction ResourcesService's
    // cross-tenant probe exists to make.
    //
    // A SECURITY DEFINER function alone does NOT fix this: FORCE ROW LEVEL
    // SECURITY applies its policy to the table owner too, and a SECURITY
    // DEFINER function's effective owner is exactly that owner — confirmed
    // empirically (Postgres's own error message, when this was tried with
    // app_migrator as owner, names the fix directly: give the owner
    // BYPASSRLS). `app_rls_bypass` (§13.6, created in docker/postgres/init.sh
    // and this test container's setup) exists for exactly this: a NOLOGIN
    // role with BYPASSRLS, never connected to directly, whose only job is
    // owning this kind of narrow, single-column lookup function. Ownership
    // is transferred to it below, and it is separately granted SELECT on the
    // table — BYPASSRLS skips the POLICY check, not ordinary object
    // privileges.
    await queryRunner.query(`
      CREATE FUNCTION "resource_exists"(p_resource_id uuid)
      RETURNS boolean
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $$
        SELECT EXISTS (SELECT 1 FROM resources WHERE id = p_resource_id);
      $$
    `);
    await queryRunner.query(`ALTER FUNCTION "resource_exists"(uuid) OWNER TO app_rls_bypass`);
    await queryRunner.query(`GRANT SELECT ON "resources" TO app_rls_bypass`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION "resource_exists"(uuid) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION "resource_exists"(uuid) TO app_user`);

    // ── plan_limit_cache (§8.6, §19.6, RLS: yes) ────────────────────────
    // organization_id IS the primary key — one row per organisation, no
    // separate id column. RLS applies to it exactly as to any other
    // organization_id column.
    //
    // §19.4's backstop, applied to storage: used_storage_bytes is the
    // authoritative counter the limit is defined on, and these two CHECKs
    // guard that SAME column. Even if a future code path increments it
    // without taking the row lock, PostgreSQL refuses the write — the lock
    // gives correct behaviour, the constraint gives a guaranteed ceiling,
    // and both must fail for the storage limit to be breached. This is only
    // expressible because max_storage_bytes is denormalised onto the same
    // row (a CHECK cannot reference another table).
    await queryRunner.query(`
      CREATE TABLE "plan_limit_cache" (
        "organization_id" uuid PRIMARY KEY,
        "max_storage_bytes" bigint NOT NULL,
        "used_storage_bytes" bigint NOT NULL DEFAULT 0,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_plan_limit_storage"
          CHECK ("used_storage_bytes" <= "max_storage_bytes"),
        CONSTRAINT "ck_plan_limit_storage_nonneg"
          CHECK ("used_storage_bytes" >= 0)
      )
    `);
    await enableTenantRls(queryRunner, 'plan_limit_cache');

    // Mirrors the GRANT pattern in user-service's and subscription-service's
    // migrations: app_user (the runtime role — NOSUPERUSER, NOBYPASSRLS,
    // non-owner, §13.5) gets DML only. It never gets DDL, and RLS applies to
    // it in full because it owns neither table and both are FORCE-protected.
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON "resources" TO app_user
    `);
    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON "plan_limit_cache" TO app_user
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS "resource_exists"(uuid)`);
    await queryRunner.query(`DROP TABLE "plan_limit_cache"`);
    await queryRunner.query(`DROP TABLE "resources"`);
  }
}
