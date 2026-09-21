import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fixes a real, pre-existing production bug in invitation acceptance,
 * matching 1700000000004's fix for the identical class of problem on
 * `users.users`: `users.invitations` also has FORCE ROW LEVEL SECURITY, so
 * ANY query against it — including via runGlobal(), or the unscoped portion
 * of transactionWithDeferredScope() before setScope() runs — evaluates the
 * USING policy's `organization_id = NULL` as unknown/false for EVERY row,
 * app_user's own table privileges notwithstanding. UsersService.acceptInvitation
 * looks up a pending invitation BY TOKEN HASH before the organisation is
 * known (that lookup is what determines it), so this was never reachable
 * against real Postgres — confirmed empirically (`psql -U app_user` with no
 * app.current_org set returns zero rows for an existing, valid token).
 *
 * The fix follows 1700000000004's exact shape: a SECURITY DEFINER function,
 * owned by app_rls_bypass (never app_migrator — that ownership mistake is
 * the whole reason 1700000000004 exists), returning EXACTLY ONE COLUMN
 * (organization_id — never email, role, or expiry) for a token hash. Once
 * acceptInvitation has that one value, it calls setScope() and re-reads the
 * invitation through the ordinary RLS-scoped path (exactly as
 * findRoleByUserId re-reads users.users after get_user_organization_id) —
 * this function is the resolve step, never the source of truth for whether
 * the invitation is still valid.
 *
 * token_hash is safe as the lookup key for the SAME reason the token itself
 * is safe to accept with no authenticated caller at all (§11.5 elsewhere in
 * this codebase): it is a cryptographically random, single-use value, and
 * knowing it already IS the authorization to read this one row.
 */
export class AddInvitationOrganizationIdFunction1700000000005 implements MigrationInterface {
  name = 'AddInvitationOrganizationIdFunction1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION "users"."get_invitation_organization_id"(p_token_hash varchar(64))
      RETURNS uuid
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = users, pg_temp
      AS $$
        SELECT organization_id FROM users.invitations
          WHERE token_hash = p_token_hash
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > now();
      $$
    `);
    await queryRunner.query(
      `ALTER FUNCTION "users"."get_invitation_organization_id"(varchar(64)) OWNER TO app_rls_bypass`,
    );
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION "users"."get_invitation_organization_id"(varchar(64)) FROM PUBLIC`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION "users"."get_invitation_organization_id"(varchar(64)) TO app_user`,
    );

    await queryRunner.query(`GRANT SELECT ON "users"."invitations" TO app_rls_bypass`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE SELECT ON "users"."invitations" FROM app_rls_bypass`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "users"."get_invitation_organization_id"(varchar(64))`,
    );
  }
}
