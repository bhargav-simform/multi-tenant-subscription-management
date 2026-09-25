import { randomUUID } from 'node:crypto';
import { NotFoundException } from '../../src/lib/http-errors';
import { transaction, transactionForOrganization } from '../../src/lib/tenant-db';
import * as invitations from '../../src/models/invitation.model';
import * as users from '../../src/models/user.model';
import * as usersRead from '../../src/services/users-read.service';
import { Role } from '../../src/types/constants';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { runAs } from '../support/tenant-fixtures';

/**
 * Port of the old users-schema resolution regression. The bug it guarded (bare
 * entity names not resolving because app_user's search_path excluded the `users`
 * schema) cannot recur in its old form — everything now lives in `public` — so the
 * equivalent guarantees are asserted instead:
 *
 *   - users/invitations exist in `public` and resolve through app_user's DEFAULT
 *     search_path (no ALTER ROLE, no schema qualification), and the old schemas are gone;
 *   - the Prisma models read and write them through the real scoped transaction + RLS
 *     path (the exact combination that was silently broken before).
 */
describe('users/invitations resolve in the public schema through app_user (regression)', () => {
  const db = new PostgresTestContainer();
  const ORG_ID = randomUUID();
  const ADMIN_ID = randomUUID();

  beforeAll(() => db.start());
  afterAll(() => db.stop());

  it('both tables live in public, and the old per-service schemas do not exist', async () => {
    const tables = await db.prisma.$queryRaw<{ table_schema: string; table_name: string }[]>`
      SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_name IN ('users', 'invitations') ORDER BY table_name`;
    expect(tables).toEqual([
      { table_schema: 'public', table_name: 'invitations' },
      { table_schema: 'public', table_name: 'users' },
    ]);

    const schemas = await db.asSuperuser((c) =>
      c.query(`SELECT nspname FROM pg_namespace WHERE nspname IN ('users', 'subs')`),
    );
    expect(schemas.rows).toEqual([]);
  });

  it("app_user's search_path is the unmodified default and resolves the bare table names", async () => {
    await db.asAppUser(async (c) => {
      const sp = await c.query('SHOW search_path');
      expect(sp.rows[0].search_path).toBe('"$user", public');
      // Unqualified names resolve (would raise "relation does not exist" otherwise).
      const resolved = await c.query(
        `SELECT to_regclass('users')::text AS u, to_regclass('invitations')::text AS i`,
      );
      expect(resolved.rows[0]).toEqual({ u: 'users', i: 'invitations' });
    });
  });

  it('creates and reads back a User row through the model and the service', async () => {
    const created = await transactionForOrganization(ORG_ID, (tx) =>
      users.create(tx, {
        id: ADMIN_ID,
        organizationId: ORG_ID,
        email: 'admin@example.com',
        firstName: 'Ada',
        lastName: 'Admin',
        role: 'org_admin',
      }),
    );
    // The explicit id is honoured (users.id == credentials.user_id).
    expect(created.id).toBe(ADMIN_ID);
    expect(created.status).toBe('active');

    const found = await runAs(ORG_ID, ADMIN_ID, () => usersRead.getById(ADMIN_ID));
    expect(found.email).toBe('admin@example.com');
  });

  it('email is citext: the per-org unique constraint is case-insensitive', async () => {
    await expect(
      transactionForOrganization(ORG_ID, (tx) =>
        users.create(tx, {
          organizationId: ORG_ID,
          email: 'ADMIN@example.com',
          firstName: 'Dup',
          lastName: 'Licate',
          role: 'org_member',
        }),
      ),
    ).rejects.toThrow(/uq_users_org_email|Unique constraint/i);
  });

  it('RLS still isolates User reads by organization', async () => {
    const otherOrgId = randomUUID();
    const other = await transactionForOrganization(otherOrgId, (tx) =>
      users.create(tx, {
        organizationId: otherOrgId,
        email: 'other-org@example.com',
        firstName: 'Bea',
        lastName: 'Bystander',
        role: 'org_member',
      }),
    );

    const fromWrongOrg = await transactionForOrganization(ORG_ID, (tx) =>
      users.findById(tx, ORG_ID, other.id),
    );
    expect(fromWrongOrg).toBeNull();

    await expect(runAs(ORG_ID, ADMIN_ID, () => usersRead.getById(other.id))).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // The list is scoped too: only ORG_ID's one user.
    const page = await runAs(ORG_ID, ADMIN_ID, () => usersRead.listPage({}));
    expect(page.items.map((u) => u.email)).toEqual(['admin@example.com']);
  });

  it('creates and reads back an Invitation row through the model', async () => {
    const invitationId = await runAs(ORG_ID, ADMIN_ID, () =>
      transaction(async (tx) => {
        const inv = await invitations.create(tx, ORG_ID, {
          email: 'invitee@example.com',
          role: 'org_member',
          tokenHash: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        return inv.id;
      }),
    );

    const found = await runAs(ORG_ID, ADMIN_ID, () =>
      transaction((tx) => invitations.findById(tx, ORG_ID, invitationId)),
    );
    expect(found?.email).toBe('invitee@example.com');

    const pending = await runAs(ORG_ID, ADMIN_ID, () => usersRead.listPendingInvitations());
    expect(pending.map((i) => i.id)).toEqual([invitationId]);

    // A platform-admin context sees nothing (empty, not an error).
    const asAdmin = await runAs(null, randomUUID(), () => usersRead.listPendingInvitations(), [
      Role.PLATFORM_ADMIN,
    ]);
    expect(asAdmin).toEqual([]);
  });

  it('the partial unique index allows only one PENDING invitation per (org, email)', async () => {
    const create = (hash: string) =>
      transactionForOrganization(ORG_ID, (tx) =>
        invitations.create(tx, ORG_ID, {
          email: 'Pending@Example.com',
          role: 'org_member',
          tokenHash: hash,
          expiresAt: new Date(Date.now() + 86_400_000),
        }),
      );

    const first = await create('b'.repeat(64));
    await expect(create('c'.repeat(64))).rejects.toBeInstanceOf(
      invitations.InvitationAlreadyPendingError,
    );

    // Once revoked it no longer blocks a new one.
    await transactionForOrganization(ORG_ID, (tx) => invitations.markRevoked(tx, ORG_ID, first.id));
    await expect(create('d'.repeat(64))).resolves.toMatchObject({ organizationId: ORG_ID });
  });

  it('a platform-admin context reading tenant users is a hard error (500), never a silent read', async () => {
    await expect(
      runAs(null, randomUUID(), () => usersRead.listPage({}), [Role.PLATFORM_ADMIN]),
    ).rejects.toThrow(/platform-admin context/);
  });
});
