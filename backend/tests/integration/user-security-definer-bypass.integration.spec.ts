import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../../src/lib/hashing';
import { runGlobal, transactionForOrganization } from '../../src/lib/tenant-db';
import * as invitations from '../../src/models/invitation.model';
import * as users from '../../src/models/user.model';
import * as usersRead from '../../src/services/users-read.service';
import { PostgresTestContainer } from '../support/postgres-test-container';

/**
 * Regression for the SECURITY DEFINER ownership bug: FORCE RLS applies to a definer
 * function's owner too, so a function owned by a NOBYPASSRLS role sees zero rows and
 * the login role lookup returned NULL for every user. The migration fixes it by
 * making app_rls_bypass (NOLOGIN, BYPASSRLS) the owner of every such function.
 *
 * Exercised through the real production path (users-read.service
 * getRoleForAuthService, which login and refresh call) and the raw functions, on
 * connections that have already served scoped transactions.
 */
describe('user-side SECURITY DEFINER functions genuinely bypass FORCE RLS', () => {
  const db = new PostgresTestContainer();
  const ORG_ID = randomUUID();
  const OTHER_ORG_ID = randomUUID();
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    await db.start();
    userId = (
      await transactionForOrganization(ORG_ID, (tx) =>
        users.create(tx, {
          organizationId: ORG_ID,
          email: 'admin@example.com',
          firstName: 'Ada',
          lastName: 'Admin',
          role: 'org_admin',
        }),
      )
    ).id;
    otherUserId = (
      await transactionForOrganization(OTHER_ORG_ID, (tx) =>
        users.create(tx, {
          organizationId: OTHER_ORG_ID,
          email: 'member@other.example.com',
          firstName: 'Bea',
          lastName: 'Bystander',
          role: 'org_member',
        }),
      )
    ).id;
  });

  afterAll(() => db.stop());

  it('getRoleForAuthService resolves the real role — the exact path login calls', async () => {
    await expect(usersRead.getRoleForAuthService(userId)).resolves.toEqual({ role: 'org_admin' });
  });

  it('returns null for a genuinely nonexistent user id', async () => {
    await expect(usersRead.getRoleForAuthService(randomUUID())).resolves.toEqual({ role: null });
  });

  it('a user in a different organisation resolves too — reads by id, not by ambient scope', async () => {
    await expect(usersRead.getRoleForAuthService(otherUserId)).resolves.toEqual({
      role: 'org_member',
    });
  });

  it('a removed user resolves to no role (fails closed at login)', async () => {
    const removedId = (
      await transactionForOrganization(ORG_ID, async (tx) => {
        const u = await users.create(tx, {
          organizationId: ORG_ID,
          email: 'gone@example.com',
          firstName: 'Gone',
          lastName: 'User',
          role: 'org_member',
        });
        await users.markRemoved(tx, ORG_ID, u.id);
        return u;
      })
    ).id;
    await expect(usersRead.getRoleForAuthService(removedId)).resolves.toEqual({ role: null });
  });

  it('get_user_organization_id returns the real org on a connection that just served a scoped transaction', async () => {
    await db.asAppUser(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org', $1, true)", [OTHER_ORG_ID]);
      await c.query('COMMIT');
      expect(
        (await c.query("SELECT current_setting('app.current_org', true) AS v")).rows[0].v,
      ).toBe('');

      const res = await c.query('SELECT get_user_organization_id($1) AS org', [userId]);
      expect(res.rows[0].org).toBe(ORG_ID);
      // Contrast: an ordinary unscoped read on the same connection sees nothing.
      expect((await c.query('SELECT * FROM users')).rows).toHaveLength(0);
    });
  });

  it('get_user_organization_id also works from INSIDE another org scope (it ignores ambient scope)', async () => {
    const org = await transactionForOrganization(OTHER_ORG_ID, (tx) =>
      users.findOrganizationIdForUser(tx, userId),
    );
    expect(org).toBe(ORG_ID);
  });

  it('user_exists (cross-tenant probe) sees every org but returns only a boolean', async () => {
    await expect(runGlobal((tx) => users.existsInAnyOrganization(tx, userId))).resolves.toBe(true);
    await expect(
      transactionForOrganization(ORG_ID, (tx) => users.existsInAnyOrganization(tx, otherUserId)),
    ).resolves.toBe(true);
    await expect(runGlobal((tx) => users.existsInAnyOrganization(tx, randomUUID()))).resolves.toBe(
      false,
    );
  });

  it('get_invitation_organization_id resolves only a PENDING, unexpired invitation', async () => {
    const live = randomUUID();
    const expired = randomUUID();
    await transactionForOrganization(ORG_ID, async (tx) => {
      await invitations.create(tx, ORG_ID, {
        email: 'live@example.com',
        role: 'org_member',
        tokenHash: sha256Hex(live),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await invitations.create(tx, ORG_ID, {
        email: 'expired@example.com',
        role: 'org_member',
        tokenHash: sha256Hex(expired),
        expiresAt: new Date(Date.now() - 60_000),
      });
    });

    await expect(
      runGlobal((tx) => invitations.findOrganizationIdByTokenHash(tx, sha256Hex(live))),
    ).resolves.toBe(ORG_ID);
    await expect(
      runGlobal((tx) => invitations.findOrganizationIdByTokenHash(tx, sha256Hex(expired))),
    ).resolves.toBeNull();
    await expect(
      runGlobal((tx) => invitations.findOrganizationIdByTokenHash(tx, 'f'.repeat(64))),
    ).resolves.toBeNull();
  });

  it('every SECURITY DEFINER function is owned by app_rls_bypass, pins search_path, and is not PUBLIC-executable', async () => {
    const fns = await db.asSuperuser((c) =>
      c.query<{
        proname: string;
        owner: string;
        prosecdef: boolean;
        proconfig: string[] | null;
        public_exec: boolean;
        app_user_exec: boolean;
      }>(`
        SELECT p.proname, r.rolname AS owner, p.prosecdef, p.proconfig,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
               has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec
          FROM pg_proc p
          JOIN pg_roles r ON r.oid = p.proowner
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
         ORDER BY p.proname`),
    );

    expect(fns.rows.map((f) => f.proname)).toEqual([
      'get_invitation_organization_id',
      'get_usage_aggregates',
      'get_user_organization_id',
      'resource_exists',
      'user_exists',
    ]);
    for (const fn of fns.rows) {
      expect(fn.owner).toBe('app_rls_bypass');
      expect(fn.proconfig).toEqual(['search_path=public, pg_temp']);
      expect(fn.public_exec).toBe(false);
      expect(fn.app_user_exec).toBe(true);
    }

    // The owner is a non-login BYPASSRLS role — nothing can connect as it.
    const role = await db.asSuperuser((c) =>
      c.query(
        `SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'app_rls_bypass'`,
      ),
    );
    expect(role.rows[0]).toEqual({ rolcanlogin: false, rolbypassrls: true, rolsuper: false });
  });
});
