import { randomUUID } from 'node:crypto';
import { resetThrottleState } from '../../src/middlewares/throttle';
import {
  API,
  HttpHarness,
  PASSWORD,
  bearer,
  validationBody,
  type OrgAdminSession,
  type Session,
} from '../support/http-harness';

const NOT_FOUND = { message: 'Not Found', statusCode: 404 };
const LAST_ADMIN = {
  statusCode: 409,
  error: 'LAST_ADMIN_PROTECTED',
  message:
    'This organisation must have at least one admin. Promote another member before removing or demoting this one.',
};
const forbidden = (message: string) => ({ message, error: 'Forbidden', statusCode: 403 });

/** /users/*, /invitations/*: the seat-limit and last-admin paths, and T1 for users. */
describe('HTTP contract: users and invitations', () => {
  const h = new HttpHarness();
  let orgA: OrgAdminSession;
  let orgB: OrgAdminSession;
  let memberA: Session;

  beforeAll(async () => {
    await h.start();
    orgA = await h.signup();
    orgB = await h.signup();
    memberA = await h.addMember(orgA, 'org_member', 'Alice');
  });
  afterAll(() => h.stop());
  beforeEach(() => resetThrottleState());

  const invite = (session: Session, body: Record<string, unknown>) =>
    h.http().post(`${API}/users/invite`).set(bearer(session)).send(body);
  const email = () => `invitee-${randomUUID().slice(0, 8)}@example.com`;

  async function usedSeats(orgId: string): Promise<number> {
    const [row] = await h.superuserQuery<{ used_seats: number }>(
      `SELECT used_seats FROM subscriptions WHERE organization_id = $1`,
      [orgId],
    );
    return row.used_seats;
  }

  async function securityEventsFor(subjectId: string) {
    return h.superuserQuery<{ organization_id: string; actor_user_id: string; payload: unknown }>(
      `SELECT organization_id, actor_user_id, payload FROM security_events
        WHERE event_type = 'CrossTenantAccessAttempted' AND payload->>'subjectId' = $1`,
      [subjectId],
    );
  }

  describe('POST /users/invite', () => {
    it('201 with the invitation id and the dev token; the invitation holds a seat', async () => {
      const org = await h.signup();
      const before = await usedSeats(org.organizationId);
      const res = await invite(org, { email: email(), role: 'org_member' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        invitationId: expect.any(String),
        tokenForDev: expect.any(String),
      });
      expect(await usedSeats(org.organizationId)).toBe(before + 1);
    });

    it('409 Conflict for a second pending invitation to the same email', async () => {
      const addr = email();
      await invite(orgA, { email: addr, role: 'org_member' });
      const res = await invite(orgA, { email: addr.toUpperCase(), role: 'org_admin' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        message: `An invitation for "${addr.toUpperCase()}" is already pending in this organization`,
        error: 'Conflict',
        statusCode: 409,
      });
    });

    it('409 PLAN_LIMIT_EXCEEDED once every seat is held, with the specific message', async () => {
      const org = await h.signup();
      // The onboarding admin holds no seat (unchanged behaviour), so five invites fill it.
      for (let i = 0; i < 5; i++)
        expect((await invite(org, { email: email(), role: 'org_member' })).status).toBe(201);

      const res = await invite(org, { email: email(), role: 'org_member' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        statusCode: 409,
        error: 'PLAN_LIMIT_EXCEEDED',
        message:
          'Your plan allows 5 seats. All 5 are held (1 users, 5 pending invitations). ' +
          'Remove a user or revoke a pending invitation before inviting another.',
        details: {
          limitType: 'seats',
          limit: 5,
          current: 5,
          planCode: 'unknown',
          activeUsers: 1,
          pendingInvitations: 5,
        },
      });
    });

    it('T3 over HTTP: 5-seat plan with 4 held, two concurrent invites — exactly one 201, one 409', async () => {
      const org = await h.signup();
      for (let i = 0; i < 4; i++) await invite(org, { email: email(), role: 'org_member' });

      const results = await Promise.all([
        invite(org, { email: email(), role: 'org_member' }),
        invite(org, { email: email(), role: 'org_member' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body.error).toBe('PLAN_LIMIT_EXCEEDED');
      expect(await usedSeats(org.organizationId)).toBe(5);
    });

    it('400 for an invalid email and role', async () => {
      const res = await invite(orgA, { email: 'x', role: 'boss' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: [
          'email must be an email',
          'role must be one of the following values: org_admin, org_member',
        ],
        error: 'Bad Request',
        statusCode: 400,
      });
    });

    it('400 for a smuggled organizationId', async () => {
      const res = await invite(orgA, {
        email: email(),
        role: 'org_member',
        organizationId: orgB.organizationId,
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toEqual(['property organizationId should not exist']);
    });

    it('403 for an org member', async () => {
      const res = await invite(memberA, { email: email(), role: 'org_member' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual(forbidden('You do not have permission to create User'));
    });

    it('401 without a token', async () => {
      const res = await h
        .http()
        .post(`${API}/users/invite`)
        .send({ email: email(), role: 'org_member' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /users', () => {
    it("200 keyset page of the caller's org only, newest first, for admins and members", async () => {
      for (const session of [orgA, memberA]) {
        const res = await h.http().get(`${API}/users`).set(bearer(session));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ items: expect.any(Array), nextCursor: null, hasMore: false });
        expect(res.body.items.map((u: { id: string }) => u.id)).toEqual([
          memberA.userId,
          orgA.userId,
        ]);
        expect(res.body.items[0]).toEqual({
          id: memberA.userId,
          email: memberA.email,
          firstName: 'Alice',
          lastName: 'Member',
          role: 'org_member',
          status: 'active',
        });
      }
    });

    it('limit + cursor paginate without overlap', async () => {
      const first = await h.http().get(`${API}/users?limit=1`).set(bearer(orgA));
      expect(first.body).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
      const second = await h
        .http()
        .get(`${API}/users?limit=1&cursor=${first.body.nextCursor}`)
        .set(bearer(orgA));
      expect(second.body.items[0].id).toBe(orgA.userId);
      expect(second.body.hasMore).toBe(false);
    });

    it('400 for an invalid limit', async () => {
      const res = await h.http().get(`${API}/users?limit=abc`).set(bearer(orgA));
      expect(res.status).toBe(400);
      expect(res.body).toEqual(validationBody('limit must be an integer number'));
    });
  });

  describe('GET /users/:id (T1)', () => {
    it("200 for a user in the caller's org", async () => {
      const res = await h.http().get(`${API}/users/${memberA.userId}`).set(bearer(orgA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: memberA.userId,
        email: memberA.email,
        firstName: 'Alice',
        lastName: 'Member',
        role: 'org_member',
        status: 'active',
      });
    });

    it("404 (not 403) for another org's user, no trace of them, and a CrossTenantAccessAttempted event", async () => {
      const res = await h.http().get(`${API}/users/${orgB.userId}`).set(bearer(orgA));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(res.text).not.toContain(orgB.email);

      expect(await securityEventsFor(orgB.userId)).toEqual([
        {
          organization_id: orgA.organizationId,
          actor_user_id: orgA.userId,
          payload: {
            subjectType: 'User',
            subjectId: orgB.userId,
            actorOrganizationId: orgA.organizationId,
            actorUserId: orgA.userId,
          },
        },
      ]);
    });

    it('a genuinely missing id is the identical 404, with no security event', async () => {
      const missing = randomUUID();
      const res = await h.http().get(`${API}/users/${missing}`).set(bearer(orgA));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(await securityEventsFor(missing)).toEqual([]);
    });

    it('500 for a malformed id (no UUID pipe on this route, as before)', async () => {
      const res = await h.http().get(`${API}/users/not-a-uuid`).set(bearer(orgA));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    });
  });

  describe('PATCH /users/:id/role', () => {
    it('200 promotes a member, then demotes them again', async () => {
      const org = await h.signup();
      const m = await h.addMember(org);

      const up = await h
        .http()
        .patch(`${API}/users/${m.userId}/role`)
        .set(bearer(org))
        .send({ role: 'org_admin' });
      expect(up.status).toBe(200);
      expect(up.body).toEqual({
        id: m.userId,
        email: m.email,
        firstName: 'Mo',
        lastName: 'Member',
        role: 'org_admin',
        status: 'active',
      });

      // With two admins, the original one may now be demoted.
      const down = await h
        .http()
        .patch(`${API}/users/${org.userId}/role`)
        .set(bearer(org))
        .send({ role: 'org_member' });
      expect(down.status).toBe(200);
      expect(down.body.role).toBe('org_member');

      // The role change applies at the next login.
      const relogin = await h.login(org.email, PASSWORD);
      const self = await h
        .http()
        .post(`${API}/users/invite`)
        .set(bearer(relogin))
        .send({ email: email(), role: 'org_member' });
      expect(self.status).toBe(403);
    });

    it('409 LAST_ADMIN_PROTECTED when demoting the only admin', async () => {
      const res = await h
        .http()
        .patch(`${API}/users/${orgA.userId}/role`)
        .set(bearer(orgA))
        .send({ role: 'org_member' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual(LAST_ADMIN);
    });

    it('re-asserting org_admin on the last admin is allowed (no demotion)', async () => {
      const res = await h
        .http()
        .patch(`${API}/users/${orgA.userId}/role`)
        .set(bearer(orgA))
        .send({ role: 'org_admin' });
      expect(res.status).toBe(200);
    });

    it("404 for another org's user, and their role is untouched", async () => {
      const res = await h
        .http()
        .patch(`${API}/users/${orgB.userId}/role`)
        .set(bearer(orgA))
        .send({ role: 'org_member' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      const [row] = await h.superuserQuery(`SELECT role FROM users WHERE id = $1`, [orgB.userId]);
      expect(row).toEqual({ role: 'org_admin' });
    });

    it('400 for an invalid role; 403 for a member', async () => {
      const bad = await h
        .http()
        .patch(`${API}/users/${memberA.userId}/role`)
        .set(bearer(orgA))
        .send({ role: 'owner' });
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual(
        validationBody('role must be one of the following values: org_admin, org_member'),
      );

      const asMember = await h
        .http()
        .patch(`${API}/users/${orgA.userId}/role`)
        .set(bearer(memberA))
        .send({ role: 'org_member' });
      expect(asMember.status).toBe(403);
      expect(asMember.body).toEqual(forbidden('You do not have permission to update User'));
    });
  });

  describe('DELETE /users/:id', () => {
    it('204 soft-removes the user and frees their seat; they drop out of the list', async () => {
      const org = await h.signup();
      const m = await h.addMember(org);
      const seatsBefore = await usedSeats(org.organizationId);

      const res = await h.http().delete(`${API}/users/${m.userId}`).set(bearer(org));
      expect(res.status).toBe(204);
      expect(await usedSeats(org.organizationId)).toBe(seatsBefore - 1);

      // Soft removal: by id the row still resolves, now with status 'removed' (as before).
      const byId = await h.http().get(`${API}/users/${m.userId}`).set(bearer(org));
      expect(byId.status).toBe(200);
      expect(byId.body.status).toBe('removed');
      const list = await h.http().get(`${API}/users`).set(bearer(org));
      expect(list.body.items.map((u: { id: string }) => u.id)).not.toContain(m.userId);

      // A second delete is a 404; a removed user cannot log in (fails closed).
      expect((await h.http().delete(`${API}/users/${m.userId}`).set(bearer(org))).status).toBe(404);
      resetThrottleState();
      const login = await h
        .http()
        .post(`${API}/auth/login`)
        .send({ email: m.email, password: PASSWORD });
      expect(login.status).toBe(401);
    });

    it('409 LAST_ADMIN_PROTECTED when removing the only admin (even oneself)', async () => {
      const res = await h.http().delete(`${API}/users/${orgA.userId}`).set(bearer(orgA));
      expect(res.status).toBe(409);
      expect(res.body).toEqual(LAST_ADMIN);
    });

    it("404 for another org's user, who survives", async () => {
      const res = await h.http().delete(`${API}/users/${orgB.userId}`).set(bearer(orgA));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      const [row] = await h.superuserQuery(`SELECT status FROM users WHERE id = $1`, [orgB.userId]);
      expect(row).toEqual({ status: 'active' });
    });

    it('403 for a member', async () => {
      const res = await h.http().delete(`${API}/users/${orgA.userId}`).set(bearer(memberA));
      expect(res.status).toBe(403);
      expect(res.body).toEqual(forbidden('You do not have permission to delete User'));
    });
  });

  describe('GET /invitations', () => {
    it('200 lists pending invitations (newest first) for admins and members', async () => {
      const org = await h.signup();
      const m = await h.addMember(org);
      const a1 = email();
      const a2 = email();
      await invite(org, { email: a1, role: 'org_member' });
      await invite(org, { email: a2, role: 'org_admin' });

      for (const session of [org, m]) {
        const res = await h.http().get(`${API}/invitations`).set(bearer(session));
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
          {
            id: expect.any(String),
            email: a2,
            role: 'org_admin',
            expiresAt: expect.any(String),
            createdAt: expect.any(String),
          },
          {
            id: expect.any(String),
            email: a1,
            role: 'org_member',
            expiresAt: expect.any(String),
            createdAt: expect.any(String),
          },
        ]);
      }
    });
  });

  describe('POST /invitations/:token/accept (public)', () => {
    it('201 creates the user in the inviting org; the token is single-use (410 on replay)', async () => {
      const addr = email();
      const { body } = await invite(orgA, { email: addr, role: 'org_member' });
      const accept = () =>
        h
          .http()
          .post(`${API}/invitations/${body.tokenForDev}/accept`)
          .send({ firstName: 'Nia', lastName: 'New', password: PASSWORD });

      const res = await accept();
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        email: addr,
        firstName: 'Nia',
        lastName: 'New',
        role: 'org_member',
        status: 'active',
      });
      const [user] = await h.superuserQuery(`SELECT organization_id FROM users WHERE id = $1`, [
        res.body.id,
      ]);
      expect(user).toEqual({ organization_id: orgA.organizationId });

      const replay = await accept();
      expect(replay.status).toBe(410);
      expect(replay.body).toEqual({
        message: 'This invitation has expired or already been used.',
        error: 'Gone',
        statusCode: 410,
      });
    });

    it('410 for an unknown token and for an expired invitation', async () => {
      const unknown = await h
        .http()
        .post(`${API}/invitations/${randomUUID()}/accept`)
        .send({ firstName: 'A', lastName: 'B', password: PASSWORD });
      expect(unknown.status).toBe(410);

      const addr = email();
      const { body } = await invite(orgA, { email: addr, role: 'org_member' });
      await h.superuserQuery(
        `UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE email = $1`,
        [addr],
      );
      const expired = await h
        .http()
        .post(`${API}/invitations/${body.tokenForDev}/accept`)
        .send({ firstName: 'A', lastName: 'B', password: PASSWORD });
      expect(expired.status).toBe(410);
      expect(expired.body.error).toBe('Gone');
    });

    it('400 for an invalid body', async () => {
      const res = await h
        .http()
        .post(`${API}/invitations/whatever/accept`)
        .send({ password: 'short' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: [
          'firstName must be longer than or equal to 1 characters',
          'firstName must be a string',
          'lastName must be longer than or equal to 1 characters',
          'lastName must be a string',
          'password must be longer than or equal to 12 characters',
        ],
        error: 'Bad Request',
        statusCode: 400,
      });
    });

    it('500 when the invited email already has a login (the former remote-call quirk, kept)', async () => {
      const { body } = await invite(orgA, { email: orgB.email, role: 'org_member' });
      const res = await h
        .http()
        .post(`${API}/invitations/${body.tokenForDev}/accept`)
        .send({ firstName: 'A', lastName: 'B', password: PASSWORD });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    });
  });

  describe('DELETE /invitations/:id', () => {
    it('204 revokes and releases the seat; a second revoke is 404; the token then 410s', async () => {
      const org = await h.signup();
      const { body } = await invite(org, { email: email(), role: 'org_member' });
      expect(await usedSeats(org.organizationId)).toBe(1);

      const res = await h.http().delete(`${API}/invitations/${body.invitationId}`).set(bearer(org));
      expect(res.status).toBe(204);
      expect(await usedSeats(org.organizationId)).toBe(0);

      const again = await h
        .http()
        .delete(`${API}/invitations/${body.invitationId}`)
        .set(bearer(org));
      expect(again.status).toBe(404);
      expect(again.body).toEqual(NOT_FOUND);

      const accept = await h
        .http()
        .post(`${API}/invitations/${body.tokenForDev}/accept`)
        .send({ firstName: 'A', lastName: 'B', password: PASSWORD });
      expect(accept.status).toBe(410);
    });

    it("404 for another org's invitation, which stays pending", async () => {
      const { body } = await invite(orgB, { email: email(), role: 'org_member' });
      const res = await h
        .http()
        .delete(`${API}/invitations/${body.invitationId}`)
        .set(bearer(orgA));
      expect(res.status).toBe(404);
      const [row] = await h.superuserQuery(`SELECT revoked_at FROM invitations WHERE id = $1`, [
        body.invitationId,
      ]);
      expect(row).toEqual({ revoked_at: null });
    });

    it('403 for a member', async () => {
      const res = await h.http().delete(`${API}/invitations/${randomUUID()}`).set(bearer(memberA));
      expect(res.status).toBe(403);
      expect(res.body).toEqual(forbidden('You do not have permission to delete User'));
    });
  });
});
