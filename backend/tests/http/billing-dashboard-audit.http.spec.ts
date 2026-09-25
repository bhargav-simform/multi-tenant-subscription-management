import { randomUUID } from 'node:crypto';
import { resetThrottleState } from '../../src/middlewares/throttle';
import {
  API,
  HttpHarness,
  bearer,
  validationBody,
  type OrgAdminSession,
  type Session,
} from '../support/http-harness';

const forbidden = (message: string) => ({ message, error: 'Forbidden', statusCode: 403 });
const PLATFORM_ONLY = forbidden('This route is restricted to platform administrators');
const FREE = {
  planCode: 'free',
  planName: 'Free',
  status: 'active',
  maxSeats: 5,
  maxStorageBytes: 5_368_709_120,
};

/** /plans, /subscriptions/*, /usage, /dashboard and /audit/*. */
describe('HTTP contract: plans, subscriptions, usage, dashboard, audit', () => {
  const h = new HttpHarness();
  let orgA: OrgAdminSession;
  let orgB: OrgAdminSession;
  let memberA: Session;
  let platformAdmin: Session;

  beforeAll(async () => {
    await h.start();
    orgA = await h.signup();
    orgB = await h.signup();
    memberA = await h.addMember(orgA);
    platformAdmin = await h.createPlatformAdmin();
  });
  afterAll(() => h.stop());
  beforeEach(() => resetThrottleState());

  const invite = (session: Session) =>
    h
      .http()
      .post(`${API}/users/invite`)
      .set(bearer(session))
      .send({ email: `i-${randomUUID().slice(0, 8)}@example.com`, role: 'org_member' });

  describe('GET /plans', () => {
    it('200 with the active catalogue, for any authenticated caller', async () => {
      for (const session of [orgA, memberA, platformAdmin]) {
        const res = await h.http().get(`${API}/plans`).set(bearer(session));
        expect(res.status).toBe(200);
        const byCode = Object.fromEntries(res.body.map((p: { code: string }) => [p.code, p]));
        expect(Object.keys(byCode).sort()).toEqual(['enterprise', 'free', 'pro']);
        expect(byCode.pro).toEqual({
          id: expect.any(String),
          code: 'pro',
          name: 'Pro',
          maxUsers: 25,
          maxStorageBytes: 53_687_091_200,
        });
      }
    });

    it('401 without a token', async () => {
      const res = await h.http().get(`${API}/plans`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ message: 'Unauthorized', statusCode: 401 });
    });
  });

  describe('GET /subscriptions/current', () => {
    it("200 with the caller's own subscription (integers only), for admins and members", async () => {
      for (const session of [orgA, memberA]) {
        const res = await h.http().get(`${API}/subscriptions/current`).set(bearer(session));
        expect(res.status).toBe(200);
        // memberA accepted an invitation: one seat held.
        expect(res.body).toEqual({ ...FREE, usedSeats: 1, usedStorageBytes: 0 });
      }
    });

    it('500 for a platform admin (no organisation; always was a 500, never a 404)', async () => {
      const res = await h.http().get(`${API}/subscriptions/current`).set(bearer(platformAdmin));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    });
  });

  describe('POST /subscriptions/change', () => {
    it('201 upgrades; the new storage ceiling reaches plan_limit_cache (via the event)', async () => {
      const org = await h.signup();
      const res = await h
        .http()
        .post(`${API}/subscriptions/change`)
        .set(bearer(org))
        .send({ planCode: 'pro' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        planCode: 'pro',
        planName: 'Pro',
        status: 'active',
        usedSeats: 0,
        maxSeats: 25,
        usedStorageBytes: 0,
        maxStorageBytes: 53_687_091_200,
      });

      // A 6 GB resource did not fit the free plan's 5 GB; it fits now.
      const big = await h
        .http()
        .post(`${API}/resources`)
        .set(bearer(org))
        .send({ name: 'big', sizeBytes: 6_000_000_000 });
      expect(big.status).toBe(201);

      const history = await h.superuserQuery(
        `SELECT changed_by FROM subscription_history WHERE organization_id = $1 AND from_plan_id IS NOT NULL`,
        [org.organizationId],
      );
      expect(history).toEqual([{ changed_by: org.userId }]);
    });

    it('409 PLAN_LIMIT_EXCEEDED for a downgrade the current usage does not fit; nothing changes', async () => {
      const org = await h.signup();
      await h.http().post(`${API}/subscriptions/change`).set(bearer(org)).send({ planCode: 'pro' });
      for (let i = 0; i < 6; i++) expect((await invite(org)).status).toBe(201);

      const res = await h
        .http()
        .post(`${API}/subscriptions/change`)
        .set(bearer(org))
        .send({ planCode: 'free' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        statusCode: 409,
        error: 'PLAN_LIMIT_EXCEEDED',
        message:
          'Your organisation holds 6 seats and 0.0 GB. The Free plan allows 5 seats and 5.0 GB. ' +
          'Remove 1 user or revoke pending invitations before downgrading.',
        details: { limitType: 'seats', limit: 5, current: 6, planCode: 'free' },
      });
      const current = await h.http().get(`${API}/subscriptions/current`).set(bearer(org));
      expect(current.body.planCode).toBe('pro');
    });

    it('400 for an unknown plan code', async () => {
      const res = await h
        .http()
        .post(`${API}/subscriptions/change`)
        .set(bearer(orgA))
        .send({ planCode: 'platinum' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        validationBody('planCode must be one of the following values: free, pro, enterprise'),
      );
    });

    it('403 for a member and for a platform admin', async () => {
      for (const session of [memberA, platformAdmin]) {
        const res = await h
          .http()
          .post(`${API}/subscriptions/change`)
          .set(bearer(session))
          .send({ planCode: 'pro' });
        expect(res.status).toBe(403);
        expect(res.body).toEqual(forbidden('You do not have permission to update Subscription'));
      }
    });
  });

  describe('GET /usage (platform admin only)', () => {
    it('200 with per-organisation counters for every org; the filter narrows to one', async () => {
      const all = await h.http().get(`${API}/usage`).set(bearer(platformAdmin));
      expect(all.status).toBe(200);
      const ids = all.body.map((r: { organizationId: string }) => r.organizationId);
      expect(ids).toEqual(expect.arrayContaining([orgA.organizationId, orgB.organizationId]));

      const one = await h
        .http()
        .get(`${API}/usage?organizationId=${orgA.organizationId}`)
        .set(bearer(platformAdmin));
      expect(one.status).toBe(200);
      expect(one.body).toEqual([
        {
          organizationId: orgA.organizationId,
          planCode: 'free',
          usedSeats: 1,
          maxSeats: 5,
          usedStorageBytes: 0,
          maxStorageBytes: 5_368_709_120,
        },
      ]);
    });

    it('400 for a malformed organizationId', async () => {
      const res = await h.http().get(`${API}/usage?organizationId=x`).set(bearer(platformAdmin));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: ['organizationId must be a UUID'],
        error: 'Bad Request',
        statusCode: 400,
      });
    });

    it('403 for org admins and members — the gate is the only check on this route', async () => {
      for (const session of [orgA, memberA]) {
        const res = await h.http().get(`${API}/usage`).set(bearer(session));
        expect(res.status).toBe(403);
        expect(res.body).toEqual(PLATFORM_ONLY);
      }
    });
  });

  describe('GET /dashboard', () => {
    it('200 with the subscription and the five most recent users', async () => {
      const org = await h.signup();
      const members: Session[] = [];
      for (let i = 0; i < 5; i++) members.push(await h.addMember(org, 'org_member', `M${i}`));

      for (const session of [org, members[0]]) {
        const res = await h.http().get(`${API}/dashboard`).set(bearer(session));
        expect(res.status).toBe(200);
        expect(res.body.subscription).toEqual({ ...FREE, usedSeats: 5, usedStorageBytes: 0 });
        expect(res.body.recentUsers).toEqual({
          items: expect.any(Array),
          nextCursor: expect.any(String),
          hasMore: true,
        });
        expect(res.body.recentUsers.items.map((u: { id: string }) => u.id)).toEqual(
          members.map((m) => m.userId).reverse(),
        );
      }
    });

    it("403 'read User' for a platform admin (the users half fails first)", async () => {
      const res = await h.http().get(`${API}/dashboard`).set(bearer(platformAdmin));
      expect(res.status).toBe(403);
      expect(res.body).toEqual(forbidden('You do not have permission to read User'));
    });

    it('401 without a token', async () => {
      expect((await h.http().get(`${API}/dashboard`)).status).toBe(401);
    });
  });

  describe('GET /audit', () => {
    it("200: an org admin reads their own org's trail with payloads", async () => {
      const res = await h.http().get(`${API}/audit`).set(bearer(orgA));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ hasMore: false, nextCursor: null });
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const item of res.body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'actorUserId',
          'correlationId',
          'eventId',
          'eventType',
          'id',
          'occurredAt',
          'organizationId',
          'payload',
          'severity',
        ]);
        expect(item.organizationId).toBe(orgA.organizationId);
      }
    });

    it('eventType filters exactly; limit + cursor paginate', async () => {
      const filtered = await h
        .http()
        .get(`${API}/audit?eventType=InvitationAccepted`)
        .set(bearer(orgA));
      expect(filtered.body.items).toHaveLength(1);
      expect(filtered.body.items[0].eventType).toBe('InvitationAccepted');

      const first = await h.http().get(`${API}/audit?limit=1`).set(bearer(orgA));
      expect(first.body).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
      const second = await h
        .http()
        .get(`${API}/audit?limit=1&cursor=${first.body.nextCursor}`)
        .set(bearer(orgA));
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    });

    it('the request correlation id is carried into the audit row', async () => {
      const correlationId = randomUUID();
      const res = await invite(orgA).set('x-correlation-id', correlationId);
      expect(res.status).toBe(201);
      expect(res.headers['x-correlation-id']).toBe(correlationId);

      const rows = await h.superuserQuery(
        `SELECT event_type, organization_id FROM audit_events WHERE correlation_id = $1`,
        [correlationId],
      );
      expect(rows).toEqual([{ event_type: 'UserInvited', organization_id: orgA.organizationId }]);
    });

    it('an audit write failure never fails the user request (non-UUID correlation id)', async () => {
      const res = await invite(orgA).set('x-correlation-id', 'not-a-uuid');
      expect(res.status).toBe(201);
    });

    it("an org admin never sees another org's events", async () => {
      const res = await h.http().get(`${API}/audit?limit=100`).set(bearer(orgB));
      expect(
        res.body.items.every(
          (i: { organizationId: string }) => i.organizationId === orgB.organizationId,
        ),
      ).toBe(true);
    });

    it('a platform admin sees only NULL-org rows, metadata only (no payload)', async () => {
      await h.db.asSuperuser((c) =>
        c.query(
          `INSERT INTO audit_events (event_id, event_type, organization_id, correlation_id, severity, payload, occurred_at)
           VALUES (gen_random_uuid(), 'OnboardingFailed', NULL, gen_random_uuid(), 'info', '{"secret":"x"}', now())`,
        ),
      );
      const res = await h.http().get(`${API}/audit`).set(bearer(platformAdmin));
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toEqual({
        id: expect.any(String),
        eventId: expect.any(String),
        eventType: 'OnboardingFailed',
        organizationId: null,
        actorUserId: null,
        correlationId: expect.any(String),
        severity: 'info',
        occurredAt: expect.any(String),
      });
    });

    it('403 for a member; 400 for a bad limit', async () => {
      const asMember = await h.http().get(`${API}/audit`).set(bearer(memberA));
      expect(asMember.status).toBe(403);
      expect(asMember.body).toEqual(forbidden('You do not have permission to read AuditEvent'));

      const bad = await h.http().get(`${API}/audit?limit=101`).set(bearer(orgA));
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual(validationBody('limit must not be greater than 100'));
    });
  });

  describe('GET /audit/security', () => {
    it('200 for a platform admin: full rows, NULL-org (platform-level) events only', async () => {
      resetThrottleState();
      await h
        .http()
        .post(`${API}/auth/login`)
        .send({ email: `ghost-${randomUUID()}@example.com`, password: 'x' });
      await h
        .http()
        .post(`${API}/auth/login`)
        .send({ email: orgA.email, password: 'wrong-password' });

      const res = await h.http().get(`${API}/audit/security`).set(bearer(platformAdmin));
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const item of res.body.items) {
        expect(item.organizationId).toBeNull();
        expect(item).toHaveProperty('payload');
      }
      // The org-scoped bad_password event is not visible here.
      expect(res.text).not.toContain(orgA.email);
    });

    it("403 'Platform admin access required' for an org admin; CASL 403 for a member", async () => {
      const asAdmin = await h.http().get(`${API}/audit/security`).set(bearer(orgA));
      expect(asAdmin.status).toBe(403);
      expect(asAdmin.body).toEqual(forbidden('Platform admin access required'));

      const asMember = await h.http().get(`${API}/audit/security`).set(bearer(memberA));
      expect(asMember.body).toEqual(forbidden('You do not have permission to read AuditEvent'));
    });
  });
});
