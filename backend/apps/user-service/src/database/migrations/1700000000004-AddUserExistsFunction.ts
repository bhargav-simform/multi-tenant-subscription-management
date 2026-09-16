import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §13.6, §13.9, §32.4: the cross-tenant DETECTION probe in
 * UsersReadService.reportIfCrossTenantAttempt cannot be a plain unscoped
 * query, even via runGlobal() — `users.users` is FORCE-protected, so a query
 * with app.current_org unset has its USING policy evaluate
 * `organization_id = NULL`, which is unknown/false for EVERY row, not just a
 * foreign one. An unscoped SELECT can never see ANY user this way, so it can
 * never distinguish "exists in another org" from "does not exist" — the
 * exact distinction that probe exists to make.
 *
 * A plain SECURITY DEFINER function does NOT fix this on its own: FORCE ROW
 * LEVEL SECURITY applies its policy to the table owner too, and a SECURITY
 * DEFINER function's effective owner during execution IS that owner —
 * confirmed empirically. This is also why the ALREADY-COMMITTED
 * `users.get_user_organization_id` (owned by app_migrator, same table) has
 * always returned NULL in production for every user: auth-service's
 * `resolveRoles()` depends on it at every login and token refresh, so this
 * migration fixes that function's ownership too, alongside adding the new
 * one, rather than leaving that live bug for a separate migration.
 *
 * The fix for both: transfer ownership to `app_rls_bypass` (§13.6, created
 * in docker/postgres/init.sh and this repo's Testcontainers test setup) — a
 * NOLOGIN role with BYPASSRLS that nothing ever connects to directly, whose
 * only job is owning this narrow class of single-column/single-boolean
 * lookup function. BYPASSRLS skips the POLICY check only; ordinary object
 * privileges (SELECT) still apply, so that grant is added for both
 * functions' underlying table.
 */
export class AddUserExistsFunction1700000000004 implements MigrationInterface {
  name = 'AddUserExistsFunction1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION "users"."user_exists"(p_user_id uuid)
      RETURNS boolean
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = users, pg_temp
      AS $$
        SELECT EXISTS (SELECT 1 FROM users.users WHERE id = p_user_id);
      $$
    `);
    await queryRunner.query(`ALTER FUNCTION "users"."user_exists"(uuid) OWNER TO app_rls_bypass`);
    await queryRunner.query(`REVOKE ALL ON FUNCTION "users"."user_exists"(uuid) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION "users"."user_exists"(uuid) TO app_user`);

    // Fixes the pre-existing get_user_organization_id function's ownership —
    // see this migration's header comment for why this was a live bug.
    await queryRunner.query(
      `ALTER FUNCTION "users"."get_user_organization_id"(uuid) OWNER TO app_rls_bypass`,
    );

    await queryRunner.query(`GRANT SELECT ON "users"."users" TO app_rls_bypass`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE SELECT ON "users"."users" FROM app_rls_bypass`);
    await queryRunner.query(
      `ALTER FUNCTION "users"."get_user_organization_id"(uuid) OWNER TO app_migrator`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "users"."user_exists"(uuid)`);
  }
}
