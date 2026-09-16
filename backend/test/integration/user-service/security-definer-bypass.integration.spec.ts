import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { enableTenantRls, TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { User, UserRole, UserStatus } from '../../../apps/user-service/src/users/user.entity';
import { UserRepository } from '../../../apps/user-service/src/users/user.repository';

/**
 * §13.6, §32.4 — regression test for a severe, previously-undetected bug in
 * ALREADY-COMMITTED code: `users.get_user_organization_id`, the SECURITY
 * DEFINER function `UserRepository.findRoleByUserId` depends on (which
 * auth-service's `resolveRoles()` calls at EVERY login and token refresh),
 * has always returned NULL in production for every user.
 *
 * Root cause: FORCE ROW LEVEL SECURITY applies its policy to the table
 * owner too — that is the entire point of FORCE — and Postgres extends that
 * to a SECURITY DEFINER function's effective owner during execution. A
 * function owned by app_migrator (NOBYPASSRLS, like every role in this
 * system before this fix) gets NO RLS bypass inside it; the migration's own
 * doc comment claiming "runs with app_migrator's privileges... bypasses
 * FORCE ROW LEVEL SECURITY" was simply wrong, and nothing had ever exercised
 * this function against a real Postgres container to catch it — every
 * existing test mocks `runGlobal()` rather than the database underneath it.
 *
 * Fixed by transferring the function's ownership to `app_rls_bypass` (a
 * NOLOGIN, BYPASSRLS role nothing ever connects to directly) in migration
 * 1700000000004. This test exercises the REAL function against a REAL
 * Postgres container, through the actual `UserRepository.findRoleByUserId`
 * production code path — not a mock of any part of it.
 */
describe('users.get_user_organization_id — SECURITY DEFINER genuinely bypasses FORCE RLS (§32.4)', () => {
  jest.setTimeout(120_000);

  const db = new PostgresTestContainer();
  const ORG_ID = randomUUID();
  const OTHER_ORG_ID = randomUUID();

  let tenantAwareDataSource: TenantAwareDataSource;
  let userRepository: UserRepository;
  let userId: string;

  beforeAll(async () => {
    await db.start([User], 'users');

    await db.runMigration(async (qr) => {
      await qr.query(`CREATE EXTENSION IF NOT EXISTS citext`);
      await qr.query(`CREATE SCHEMA IF NOT EXISTS users`);
      await qr.query(`CREATE TYPE "users"."users_role_enum" AS ENUM ('org_admin', 'org_member')`);
      await qr.query(`CREATE TYPE "users"."users_status_enum" AS ENUM ('active', 'removed')`);
      await qr.query(`
        CREATE TABLE "users"."users" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "organization_id" uuid NOT NULL,
          "email" citext NOT NULL,
          "first_name" varchar(255) NOT NULL,
          "last_name" varchar(255) NOT NULL,
          "role" "users"."users_role_enum" NOT NULL,
          "status" "users"."users_status_enum" NOT NULL DEFAULT 'active',
          "created_at" timestamptz NOT NULL DEFAULT now(),
          "updated_at" timestamptz NOT NULL DEFAULT now(),
          "deleted_at" timestamptz,
          CONSTRAINT "uq_users_org_email" UNIQUE ("organization_id", "email")
        )
      `);
      await enableTenantRls(qr, 'users.users');

      // Mirrors CreateUsersAndInvitations's function exactly.
      await qr.query(`
        CREATE FUNCTION "users"."get_user_organization_id"(p_user_id uuid)
        RETURNS uuid
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = users, pg_temp
        AS $$
          SELECT organization_id FROM users.users WHERE id = p_user_id;
        $$
      `);
      await qr.query(`REVOKE ALL ON FUNCTION "users"."get_user_organization_id"(uuid) FROM PUBLIC`);
      await qr.query(`GRANT EXECUTE ON FUNCTION "users"."get_user_organization_id"(uuid) TO app_user`);

      // Needed before the ownership transfer below: ALTER FUNCTION ... OWNER
      // TO requires the target role to have privileges on the schema the
      // function lives in.
      await qr.query(`GRANT ALL ON SCHEMA "users" TO app_rls_bypass`);

      // The fix under test: mirrors migration 1700000000004's ownership
      // transfer. Comment this block out to see this suite fail with the
      // real production bug (NULL / no role resolved for every user).
      await qr.query(`ALTER FUNCTION "users"."get_user_organization_id"(uuid) OWNER TO app_rls_bypass`);
      await qr.query(`GRANT SELECT ON "users"."users" TO app_rls_bypass`);
    });
    await db.grantAppUserAccessToSchema('users');
    await db.connectAppDataSource();

    const tenantContext = new TenantContextStore();
    tenantAwareDataSource = new TenantAwareDataSource(db.appDataSource, tenantContext);
    userRepository = new UserRepository(tenantAwareDataSource, tenantContext);

    userId = await tenantAwareDataSource.transactionForOrganization(ORG_ID, async (manager) => {
      const created = await manager.getRepository(User).save(
        manager.getRepository(User).create({
          organizationId: ORG_ID,
          email: 'admin@example.com',
          firstName: 'Ada',
          lastName: 'Admin',
          role: UserRole.ORG_ADMIN,
          status: UserStatus.ACTIVE,
        }),
      );
      return created.id;
    });
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  it('findRoleByUserId resolves the real role for a real user id — the exact path auth-service calls at login', async () => {
    const role = await userRepository.findRoleByUserId(userId);
    expect(role).toBe(UserRole.ORG_ADMIN);
  });

  it('findRoleByUserId returns null for a genuinely nonexistent user id', async () => {
    const role = await userRepository.findRoleByUserId(randomUUID());
    expect(role).toBeNull();
  });

  it('the underlying function itself returns the real organization id, not NULL, on a connection that has already served a scoped transaction', async () => {
    // Establishes the reused-connection precondition (§32.4) — the pool has
    // already run a scoped transaction (the beforeAll seed, and the test
    // above), so app.current_org carries a leftover empty string, not a
    // pristine NULL, on whichever connection this query lands on.
    const rows = await db.appDataSource.query<{ get_user_organization_id: string | null }[]>(
      `SELECT users.get_user_organization_id($1)`,
      [userId],
    );
    expect(rows[0]?.get_user_organization_id).toBe(ORG_ID);
  });

  it('a user in a different organisation does not affect the lookup — the function reads by id, not by ambient scope', async () => {
    const otherUserId = await tenantAwareDataSource.transactionForOrganization(
      OTHER_ORG_ID,
      async (manager) => {
        const created = await manager.getRepository(User).save(
          manager.getRepository(User).create({
            organizationId: OTHER_ORG_ID,
            email: 'member@other.example.com',
            firstName: 'Bea',
            lastName: 'Bystander',
            role: UserRole.ORG_MEMBER,
            status: UserStatus.ACTIVE,
          }),
        );
        return created.id;
      },
    );

    const role = await userRepository.findRoleByUserId(otherUserId);
    expect(role).toBe(UserRole.ORG_MEMBER);
  });
});
