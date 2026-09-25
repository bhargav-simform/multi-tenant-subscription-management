import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../src/app';
import { registerEventHandlers } from '../../src/events';
import { hashPassword } from '../../src/lib/hashing';
import { resetThrottleState } from '../../src/middlewares/throttle';
import { PostgresTestContainer } from './postgres-test-container';

export const API = '/api/v1';
export const PASSWORD = 'correct-horse-battery-staple';

export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  organizationId: string | null;
  email: string;
  password: string;
}

export interface OrgAdminSession extends Session {
  organizationId: string;
  organizationName: string;
}

/**
 * One Testcontainers database + one createApp() per HTTP test file. The event
 * handlers are registered (as server.ts does), so signup really creates the first
 * admin user and the plan-limit cache, and every event really lands in the audit
 * tables — the flows are the production flows, not stubs.
 *
 * The helpers reset the throttle counters before they call the strict-bucket
 * routes, so fixture setup never eats a test's rate-limit budget.
 */
export class HttpHarness {
  readonly db = new PostgresTestContainer();
  app!: Express;

  async start(): Promise<void> {
    await this.db.start();
    registerEventHandlers();
    this.app = createApp();
  }

  async stop(): Promise<void> {
    await this.db.stop();
  }

  http() {
    return request(this.app);
  }

  /** Self-service onboarding, then a login as the new org admin. */
  async signup(name = `Org ${randomUUID().slice(0, 8)}`): Promise<OrgAdminSession> {
    const email = `admin-${randomUUID().slice(0, 8)}@example.com`;
    resetThrottleState();
    const res = await this.http().post(`${API}/onboarding/signup`).send({
      organizationName: name,
      adminEmail: email,
      adminPassword: PASSWORD,
      adminFirstName: 'Ada',
      adminLastName: 'Admin',
      idempotencyKey: randomUUID(),
    });
    if (res.status !== 201) {
      throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const session = await this.login(email, PASSWORD);
    return {
      ...session,
      organizationId: res.body.organizationId as string,
      organizationName: name,
    };
  }

  async login(email: string, password: string): Promise<Session> {
    resetThrottleState();
    const res = await this.http().post(`${API}/auth/login`).send({ email, password });
    if (res.status !== 200) {
      throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return {
      accessToken: res.body.accessToken,
      refreshToken: res.body.refreshToken,
      userId: res.body.user.id,
      organizationId: res.body.user.organizationId,
      email,
      password,
    };
  }

  /** Invite + accept + login: a real second user in the admin's org. */
  async addMember(
    admin: Session,
    role: 'org_member' | 'org_admin' = 'org_member',
    firstName = 'Mo',
  ): Promise<Session> {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
    const invited = await this.http()
      .post(`${API}/users/invite`)
      .set(bearer(admin))
      .send({ email, role });
    if (invited.status !== 201) {
      throw new Error(`invite failed: ${invited.status} ${JSON.stringify(invited.body)}`);
    }
    const accepted = await this.http()
      .post(`${API}/invitations/${invited.body.tokenForDev}/accept`)
      .send({ firstName, lastName: 'Member', password: PASSWORD });
    if (accepted.status !== 201) {
      throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
    }
    return this.login(email, PASSWORD);
  }

  /**
   * A platform admin is only a credentials row with organization_id NULL (see
   * prisma/seed-platform-admin.ts) — no users row. Inserted as the migrator, then a
   * real login.
   */
  async createPlatformAdmin(): Promise<Session> {
    const email = `platform-${randomUUID().slice(0, 8)}@platform.local`;
    const hash = await hashPassword(PASSWORD);
    await this.db.asMigrator((c) =>
      c.query(
        `INSERT INTO credentials (user_id, organization_id, email, password_hash, status)
         VALUES (gen_random_uuid(), NULL, $1, $2, 'active')`,
        [email, hash],
      ),
    );
    return this.login(email, PASSWORD);
  }

  /** Reads rows past RLS, for asserting what the app wrote (audit/security trails). */
  async superuserQuery<T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.db.asSuperuser(async (c) => (await c.query<T>(sql, params)).rows);
  }
}

export function bearer(session: Pick<Session, 'accessToken'>): { Authorization: string } {
  return { Authorization: `Bearer ${session.accessToken}` };
}

/** The class-validator 400 body shape. */
export function validationBody(...messages: string[]) {
  return { message: expect.arrayContaining(messages), error: 'Bad Request', statusCode: 400 };
}
