import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { enableTenantRls, TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { User, UserRole, UserStatus } from '../../../apps/user-service/src/users/user.entity';
import { Invitation } from '../../../apps/user-service/src/invitations/invitation.entity';
import { UserRepository } from '../../../apps/user-service/src/users/user.repository';
import { InvitationRepository } from '../../../apps/user-service/src/invitations/invitation.repository';

/**
 * Regression test for a real bug found via empirical Postgres testing: a
 * role with no explicit ALTER ROLE (exactly app_user, in every environment)
 * has search_path "$user", public — which does NOT include the `users`
 * schema `users.users`/`users.invitations` actually live in. `User`'s and
 * `Invitation`'s bare `@Entity('users')`/`@Entity('invitations')` therefore
 * fail to resolve UNLESS the DataSource itself carries `schema: 'users'`
 * (verified separately: an entity's own explicit `schema` still overrides
 * this default, which is what keeps SubscriptionSeatView resolving to
 * `subs` from the SAME DataSource — see app.module.ts).
 *
 * The existing seat-lock.integration.spec.ts never caught this because it
 * only exercises SubscriptionSeatView, which self-qualifies its schema and
 * so was never affected. This test exercises User AND Invitation through the
 * real TenantAwareDataSource + repository + RLS path instead — the exact
 * combination that was silently broken. It uses `enableTenantRls`, the same
 * helper the real migration calls, rather than hand-rolled DDL, so the
 * policy shape (including WITH CHECK) matches production exactly.
 */
describe('User/Invitation entity resolution against the users schema (regression)', () => {
  jest.setTimeout(120_000);

  const db = new PostgresTestContainer();
  const ORG_ID = randomUUID();

  let tenantAwareDataSource: TenantAwareDataSource;
  let userRepository: UserRepository;
  let invitationRepository: InvitationRepository;
  let tenantContext: TenantContextStore;

  beforeAll(async () => {
    // Mirrors apps/user-service/src/app.module.ts's TypeOrmModule config:
    // schema: 'users' is the fix under test — remove it here to see this
    // suite fail with "relation \"users\" does not exist".
    await db.start([User, Invitation], 'users');

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

      await qr.query(`
        CREATE TABLE "users"."invitations" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "organization_id" uuid NOT NULL,
          "email" citext NOT NULL,
          "role" "users"."users_role_enum" NOT NULL,
          "token_hash" varchar(64) NOT NULL,
          "expires_at" timestamptz NOT NULL,
          "accepted_at" timestamptz,
          "revoked_at" timestamptz,
          "created_at" timestamptz NOT NULL DEFAULT now(),
          "updated_at" timestamptz NOT NULL DEFAULT now(),
          "deleted_at" timestamptz,
          CONSTRAINT "uq_invitations_token_hash" UNIQUE ("token_hash")
        )
      `);
      await enableTenantRls(qr, 'users.invitations');
    });
    await db.grantAppUserAccessToSchema('users');
    await db.connectAppDataSource();

    tenantContext = new TenantContextStore();
    tenantAwareDataSource = new TenantAwareDataSource(db.appDataSource, tenantContext);
    userRepository = new UserRepository(tenantAwareDataSource, tenantContext);
    invitationRepository = new InvitationRepository(tenantContext);
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  function withContext<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { userId: 'test-user', organizationId, roles: [], correlationId: randomUUID(), iat: 0, exp: 0 },
      work,
    );
  }

  it('creates and reads back a User row through the bare @Entity(\'users\') mapping', async () => {
    const created = await tenantAwareDataSource.transactionForOrganization(ORG_ID, async (manager) => {
      const repo = manager.getRepository(User);
      return repo.save(
        repo.create({
          organizationId: ORG_ID,
          email: 'admin@example.com',
          firstName: 'Ada',
          lastName: 'Admin',
          role: UserRole.ORG_ADMIN,
          status: UserStatus.ACTIVE,
        }),
      );
    });

    expect(created.id).toBeDefined();

    const found = await tenantAwareDataSource.transactionForOrganization(ORG_ID, async (manager) =>
      withContext(ORG_ID, () => userRepository.findById(created.id, manager)),
    );

    expect(found?.email).toBe('admin@example.com');
  });

  it('RLS still isolates User reads by organization through the same bare-named entity', async () => {
    const otherOrgId = randomUUID();
    const created = await tenantAwareDataSource.transactionForOrganization(otherOrgId, async (manager) => {
      const repo = manager.getRepository(User);
      return repo.save(
        repo.create({
          organizationId: otherOrgId,
          email: 'other-org@example.com',
          firstName: 'Bea',
          lastName: 'Bystander',
          role: UserRole.ORG_MEMBER,
          status: UserStatus.ACTIVE,
        }),
      );
    });

    const foundFromWrongOrg = await tenantAwareDataSource.transactionForOrganization(ORG_ID, async (manager) =>
      withContext(ORG_ID, () => userRepository.findById(created.id, manager)),
    );

    expect(foundFromWrongOrg).toBeNull();
  });

  it('creates and reads back an Invitation row through the bare @Entity(\'invitations\') mapping', async () => {
    const invitationId = await withContext(ORG_ID, () =>
      tenantAwareDataSource.transaction(async (manager) => {
        const invitation = await invitationRepository.create(
          {
            email: 'invitee@example.com',
            role: UserRole.ORG_MEMBER,
            tokenHash: 'a'.repeat(64),
            expiresAt: new Date(Date.now() + 86_400_000),
          },
          manager,
        );
        return invitation.id;
      }),
    );

    await withContext(ORG_ID, () =>
      tenantAwareDataSource.transaction(async (manager) => {
        const found = await invitationRepository.findById(invitationId, manager);
        expect(found?.email).toBe('invitee@example.com');
      }),
    );
  });
});
