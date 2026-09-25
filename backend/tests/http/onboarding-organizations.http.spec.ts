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

/** POST /onboarding/signup (the saga) and the three /organizations routes. */
describe('HTTP contract: onboarding and organizations', () => {
  const h = new HttpHarness();
  let admin: OrgAdminSession;
  let member: Session;
  let platformAdmin: Session;

  beforeAll(async () => {
    await h.start();
    admin = await h.signup();
    member = await h.addMember(admin);
    platformAdmin = await h.createPlatformAdmin();
  });
  afterAll(() => h.stop());
  beforeEach(() => resetThrottleState());

  function signupBody(overrides: Record<string, unknown> = {}) {
    return {
      organizationName: `Acme ${randomUUID().slice(0, 8)}`,
      adminEmail: `founder-${randomUUID().slice(0, 8)}@example.com`,
      adminPassword: PASSWORD,
      adminFirstName: 'Fay',
      adminLastName: 'Founder',
      idempotencyKey: randomUUID(),
      ...overrides,
    };
  }

  const PLATFORM_ONLY = {
    message: 'This route is restricted to platform administrators',
    error: 'Forbidden',
    statusCode: 403,
  };

  describe('POST /onboarding/signup', () => {
    it('201 with the provisioned organisation, and every saga step really happened', async () => {
      const body = signupBody({ organizationName: 'Globex  Corp!' });
      const res = await h.http().post(`${API}/onboarding/signup`).send(body);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        organizationId: expect.any(String),
        organizationName: 'Globex  Corp!',
        status: 'active',
      });
      const orgId = res.body.organizationId as string;

      const [org] = await h.superuserQuery(`SELECT slug, status FROM organizations WHERE id = $1`, [
        orgId,
      ]);
      expect(org).toEqual({ slug: 'globex-corp', status: 'active' });

      const [saga] = await h.superuserQuery(
        `SELECT state, attempts, last_error FROM onboarding_sagas WHERE idempotency_key = $1`,
        [body.idempotencyKey],
      );
      expect(saga).toEqual({ state: 'complete', attempts: 4, last_error: null });

      // The first admin's users row carries the credential's minted user id.
      const [cred] = await h.superuserQuery<{ user_id: string }>(
        `SELECT user_id FROM credentials WHERE email = $1`,
        [body.adminEmail],
      );
      const users = await h.superuserQuery(
        `SELECT id, role, first_name FROM users WHERE organization_id = $1`,
        [orgId],
      );
      expect(users).toEqual([{ id: cred.user_id, role: 'org_admin', first_name: 'Fay' }]);

      // The subscription and the storage ceiling the resource path locks.
      const [sub] = await h.superuserQuery(
        `SELECT used_seats, max_seats_snapshot FROM subscriptions WHERE organization_id = $1`,
        [orgId],
      );
      expect(sub).toEqual({ used_seats: 0, max_seats_snapshot: 5 });
      const [cache] = await h.superuserQuery(
        `SELECT max_storage_bytes::text AS max FROM plan_limit_cache WHERE organization_id = $1`,
        [orgId],
      );
      expect(cache).toEqual({ max: '5368709120' });

      // Every step's event landed in the org's audit trail.
      const events = await h.superuserQuery<{ event_type: string }>(
        `SELECT event_type FROM audit_events WHERE organization_id = $1 ORDER BY occurred_at, created_at`,
        [orgId],
      );
      expect(events.map((e) => e.event_type)).toEqual(
        expect.arrayContaining([
          'OrganizationCreated',
          'UserCredentialsCreated',
          'SubscriptionAssigned',
          'OrganizationProvisioned',
        ]),
      );

      // And the new admin can log in.
      const login = await h
        .http()
        .post(`${API}/auth/login`)
        .send({ email: body.adminEmail, password: PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.user).toMatchObject({ roles: ['org_admin'], organizationId: orgId });
    });

    it('replaying the same idempotency key returns the same organisation, never a duplicate', async () => {
      const body = signupBody();
      const first = await h.http().post(`${API}/onboarding/signup`).send(body);
      const again = await h.http().post(`${API}/onboarding/signup`).send(body);

      expect(again.status).toBe(201);
      expect(again.body).toEqual(first.body);
      const orgs = await h.superuserQuery(`SELECT id FROM organizations WHERE name = $1`, [
        body.organizationName,
      ]);
      expect(orgs).toHaveLength(1);
    });

    it('409 Conflict when the organisation name (slug) is taken', async () => {
      const res = await h
        .http()
        .post(`${API}/onboarding/signup`)
        .send(signupBody({ organizationName: admin.organizationName }));
      const slug = admin.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        message: `Organization slug "${slug}" is already taken`,
        error: 'Conflict',
        statusCode: 409,
      });
    });

    it('409 ONBOARDING_INCOMPLETE when a step fails; a retry with the same key resumes, not restarts', async () => {
      // The admin email already has a login, so credential creation (step 2) fails.
      const body = signupBody({ adminEmail: admin.email });
      const res = await h.http().post(`${API}/onboarding/signup`).send(body);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        statusCode: 409,
        error: 'ONBOARDING_INCOMPLETE',
        message:
          'Onboarding could not complete. Retry with the same request — it will resume from where it left off.',
      });

      const [saga] = await h.superuserQuery<{ organization_id: string }>(
        `SELECT state, organization_id, last_error FROM onboarding_sagas WHERE idempotency_key = $1`,
        [body.idempotencyKey],
      );
      // state is still the last step that SUCCEEDED; the failure is recorded beside it.
      expect(saga).toMatchObject({
        state: 'org_created',
        last_error: 'Request failed with status code 409',
      });
      const [org] = await h.superuserQuery(`SELECT status FROM organizations WHERE id = $1`, [
        saga.organization_id,
      ]);
      expect(org).toEqual({ status: 'provisioning_failed' });

      const failed = await h.superuserQuery(
        `SELECT 1 FROM audit_events WHERE organization_id = $1 AND event_type = 'OnboardingFailed'`,
        [saga.organization_id],
      );
      expect(failed).toHaveLength(1);

      // Retry with the same key and a fixable input: it resumes at credential creation
      // and completes the SAME organisation.
      const retry = await h
        .http()
        .post(`${API}/onboarding/signup`)
        .send({ ...body, adminEmail: `fixed-${randomUUID().slice(0, 8)}@example.com` });
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual({
        organizationId: saga.organization_id,
        organizationName: body.organizationName,
        status: 'active',
      });
    });

    it('400 for an empty body, listing every constraint', async () => {
      const res = await h.http().post(`${API}/onboarding/signup`).send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        validationBody(
          'organizationName must be a string',
          'adminEmail must be an email',
          'adminPassword must be longer than or equal to 12 characters',
          'adminFirstName must be a string',
          'adminLastName must be a string',
          'idempotencyKey must match /^[a-zA-Z0-9-]{8,128}$/ regular expression',
        ),
      );
    });

    it('400 for a smuggled organizationId (forbidNonWhitelisted, not stripped)', async () => {
      const res = await h
        .http()
        .post(`${API}/onboarding/signup`)
        .send(signupBody({ organizationId: admin.organizationId }));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: ['property organizationId should not exist'],
        error: 'Bad Request',
        statusCode: 400,
      });
    });

    it('400 for a short password and a malformed idempotency key', async () => {
      const res = await h
        .http()
        .post(`${API}/onboarding/signup`)
        .send(signupBody({ adminPassword: 'short', idempotencyKey: 'bad key!' }));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: [
          'adminPassword must be longer than or equal to 12 characters',
          'idempotencyKey must match /^[a-zA-Z0-9-]{8,128}$/ regular expression',
        ],
        error: 'Bad Request',
        statusCode: 400,
      });
    });
  });

  describe('GET /organizations/me', () => {
    it("200 with the caller's own organisation (metadata only), for admins and members", async () => {
      for (const session of [admin, member]) {
        const res = await h.http().get(`${API}/organizations/me`).set(bearer(session));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          id: admin.organizationId,
          name: admin.organizationName,
          slug: expect.any(String),
          status: 'active',
        });
      }
    });

    it('404 for a platform admin (no "my organisation")', async () => {
      const res = await h.http().get(`${API}/organizations/me`).set(bearer(platformAdmin));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: 'Not Found', statusCode: 404 });
    });

    it('401 without a token', async () => {
      expect((await h.http().get(`${API}/organizations/me`)).status).toBe(401);
    });
  });

  describe('GET /organizations (platform admin only)', () => {
    it('200 keyset page of metadata; the cursor walks the list without overlap', async () => {
      await h.signup();
      const first = await h.http().get(`${API}/organizations?limit=1`).set(bearer(platformAdmin));
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        items: [
          {
            id: expect.any(String),
            name: expect.any(String),
            slug: expect.any(String),
            status: expect.any(String),
          },
        ],
        nextCursor: expect.any(String),
        hasMore: true,
      });

      const second = await h
        .http()
        .get(`${API}/organizations?limit=1&cursor=${first.body.nextCursor}`)
        .set(bearer(platformAdmin));
      expect(second.status).toBe(200);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.items[0].id).not.toBe(first.body.items[0].id);

      const all = await h.http().get(`${API}/organizations?limit=100`).set(bearer(platformAdmin));
      expect(all.body.hasMore).toBe(false);
      expect(all.body.nextCursor).toBeNull();
      expect(all.body.items.map((o: { id: string }) => o.id)).toContain(admin.organizationId);
    });

    it('403 for an org admin and an org member — the platform gate runs first', async () => {
      for (const session of [admin, member]) {
        const res = await h.http().get(`${API}/organizations`).set(bearer(session));
        expect(res.status).toBe(403);
        expect(res.body).toEqual(PLATFORM_ONLY);
      }
    });

    it('400 for an out-of-range limit', async () => {
      const res = await h.http().get(`${API}/organizations?limit=0`).set(bearer(platformAdmin));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: ['limit must not be less than 1'],
        error: 'Bad Request',
        statusCode: 400,
      });

      const tooBig = await h
        .http()
        .get(`${API}/organizations?limit=101`)
        .set(bearer(platformAdmin));
      expect(tooBig.body.message).toEqual(['limit must not be greater than 100']);
    });
  });

  describe('GET /organizations/:id (platform admin only)', () => {
    it('200 with the organisation metadata', async () => {
      const res = await h
        .http()
        .get(`${API}/organizations/${admin.organizationId}`)
        .set(bearer(platformAdmin));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: admin.organizationId,
        name: admin.organizationName,
        slug: expect.any(String),
        status: 'active',
      });
    });

    it('404 for an unknown id', async () => {
      const res = await h
        .http()
        .get(`${API}/organizations/${randomUUID()}`)
        .set(bearer(platformAdmin));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: 'Not Found', statusCode: 404 });
    });

    it('500 for a malformed id (no UUID pipe, as before)', async () => {
      const res = await h.http().get(`${API}/organizations/not-a-uuid`).set(bearer(platformAdmin));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    });

    it("403 for an org admin, even for their OWN organisation's id", async () => {
      const res = await h
        .http()
        .get(`${API}/organizations/${admin.organizationId}`)
        .set(bearer(admin));
      expect(res.status).toBe(403);
      expect(res.body).toEqual(PLATFORM_ONLY);
    });
  });
});
