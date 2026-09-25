import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { hashPassword, sha256Hex } from '../../src/lib/hashing';
import { resetThrottleState } from '../../src/middlewares/throttle';
import {
  API,
  HttpHarness,
  PASSWORD,
  bearer,
  validationBody,
  type OrgAdminSession,
} from '../support/http-harness';

/**
 * Contract tests for the public auth routes, the authenticate() 401 bodies, and the
 * app-level plumbing every route shares (health, correlation id, CORS, JSON parsing,
 * unknown routes). Bodies are asserted exactly: the frontend parses them.
 */
describe('HTTP contract: auth, authentication and app plumbing', () => {
  const h = new HttpHarness();
  let admin: OrgAdminSession;

  beforeAll(async () => {
    await h.start();
    admin = await h.signup();
  });
  afterAll(() => h.stop());
  beforeEach(() => resetThrottleState());

  const UNAUTHORIZED = { message: 'Unauthorized', statusCode: 401 };
  const INVALID_CREDENTIALS = {
    message: 'Invalid credentials',
    error: 'Unauthorized',
    statusCode: 401,
  };

  describe('POST /auth/login', () => {
    it('200 with the token pair and the signed-in user', async () => {
      const res = await h
        .http()
        .post(`${API}/auth/login`)
        .send({ email: admin.email, password: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        user: {
          id: admin.userId,
          email: admin.email,
          roles: ['org_admin'],
          organizationId: admin.organizationId,
        },
      });
      // The access token carries identity claims only; the org comes from here, never the body.
      const claims = jwt.decode(res.body.accessToken) as Record<string, unknown>;
      expect(claims).toMatchObject({
        sub: admin.userId,
        organizationId: admin.organizationId,
        roles: ['org_admin'],
        jti: expect.any(String),
      });
      expect(Number(claims.exp) - Number(claims.iat)).toBe(15 * 60);
    });

    it('email lookup is case-insensitive (citext)', async () => {
      const res = await h
        .http()
        .post(`${API}/auth/login`)
        .send({ email: admin.email.toUpperCase(), password: PASSWORD });
      expect(res.status).toBe(200);
    });

    it('401 for a wrong password, and records an org-scoped AuthenticationFailed event', async () => {
      const res = await h
        .http()
        .post(`${API}/auth/login`)
        .send({ email: admin.email, password: 'wrong-password' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);

      const rows = await h.superuserQuery<{ organization_id: string; payload: unknown }>(
        `SELECT organization_id, payload FROM security_events
          WHERE event_type = 'AuthenticationFailed' AND payload->>'email' = $1`,
        [admin.email],
      );
      expect(rows).toEqual([
        {
          organization_id: admin.organizationId,
          payload: { email: admin.email, reason: 'bad_password' },
        },
      ]);
    });

    it('401 identical for an unknown email (no existence oracle), recorded as a NULL-org event', async () => {
      const email = `nobody-${randomUUID()}@example.com`;
      const res = await h.http().post(`${API}/auth/login`).send({ email, password: 'whatever' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);

      const rows = await h.superuserQuery(
        `SELECT organization_id, payload->>'reason' AS reason FROM security_events WHERE payload->>'email' = $1`,
        [email],
      );
      expect(rows).toEqual([{ organization_id: null, reason: 'unknown_email' }]);
    });

    it('401 for a disabled credential', async () => {
      const other = await h.signup();
      await h.superuserQuery(`UPDATE credentials SET status = 'disabled' WHERE email = $1`, [
        other.email,
      ]);
      const res = await h
        .http()
        .post(`${API}/auth/login`)
        .send({ email: other.email, password: PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_CREDENTIALS);
    });

    it('401 "not fully provisioned" for a credential whose users row does not exist yet (fails closed)', async () => {
      const email = `orphan-${randomUUID().slice(0, 8)}@example.com`;
      const hash = await hashPassword(PASSWORD);
      await h.db.asMigrator((c) =>
        c.query(
          `INSERT INTO credentials (user_id, organization_id, email, password_hash)
           VALUES (gen_random_uuid(), $1, $2, $3)`,
          [admin.organizationId, email, hash],
        ),
      );
      const res = await h.http().post(`${API}/auth/login`).send({ email, password: PASSWORD });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        message: 'Account is not fully provisioned yet',
        error: 'Unauthorized',
        statusCode: 401,
      });
    });

    it('400 with the flattened class-validator messages (whitelist + forbidNonWhitelisted)', async () => {
      const res = await h.http().post(`${API}/auth/login`).send({ email: 'nope', extra: 1 });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: [
          'property extra should not exist',
          'email must be an email',
          'password must be longer than or equal to 1 characters',
          'password must be a string',
        ],
        error: 'Bad Request',
        statusCode: 400,
      });
    });

    it('400 for malformed JSON, from the body parser', async () => {
      const res = await h
        .http()
        .post(`${API}/auth/login`)
        .set('Content-Type', 'application/json')
        .send('{bad');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: expect.stringContaining('JSON'),
        error: 'Bad Request',
        statusCode: 400,
      });
    });
  });

  describe('POST /auth/refresh', () => {
    it('200 rotates the pair; the presented token is single-use (reuse = 403 and family revoked)', async () => {
      const session = await h.login(admin.email, PASSWORD);

      const rotated = await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: session.refreshToken });
      expect(rotated.status).toBe(200);
      expect(rotated.body).toEqual({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        user: {
          id: admin.userId,
          email: admin.email,
          roles: ['org_admin'],
          organizationId: admin.organizationId,
        },
      });
      expect(rotated.body.refreshToken).not.toBe(session.refreshToken);

      // Reusing the rotated-away token is treated as theft.
      const reused = await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: session.refreshToken });
      expect(reused.status).toBe(403);
      expect(reused.body).toEqual({
        message: 'Refresh token has been revoked',
        error: 'Forbidden',
        statusCode: 403,
      });

      // ...and the whole family went with it, including the fresh successor.
      const successor = await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: rotated.body.refreshToken });
      expect(successor.status).toBe(403);

      const events = await h.superuserQuery(
        `SELECT organization_id FROM security_events WHERE payload->>'reason' = 'refresh_token_reuse'`,
      );
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('401 for an unknown refresh token', async () => {
      const res = await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: 'not-a-real-token' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        message: 'Invalid refresh token',
        error: 'Unauthorized',
        statusCode: 401,
      });
    });

    it('401 for an expired refresh token', async () => {
      const session = await h.login(admin.email, PASSWORD);
      await h.superuserQuery(
        `UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`,
        [sha256Hex(session.refreshToken)],
      );
      const res = await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: session.refreshToken });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        message: 'Refresh token expired',
        error: 'Unauthorized',
        statusCode: 401,
      });
    });

    it('400 without a refreshToken', async () => {
      const res = await h.http().post(`${API}/auth/refresh`).send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        validationBody(
          'refreshToken must be longer than or equal to 1 characters',
          'refreshToken must be a string',
        ),
      );
    });
  });

  describe('POST /auth/logout', () => {
    it('204; the access token is denylisted immediately and the refresh token is revoked', async () => {
      const session = await h.login(admin.email, PASSWORD);
      const res = await h
        .http()
        .post(`${API}/auth/logout`)
        .set(bearer(session))
        .send({ refreshToken: session.refreshToken });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');

      const after = await h.http().get(`${API}/plans`).set(bearer(session));
      expect(after.status).toBe(401);
      expect(after.body).toEqual({
        message: 'Token has been revoked',
        error: 'Unauthorized',
        statusCode: 401,
      });

      const refresh = await h
        .http()
        .post(`${API}/auth/refresh`)
        .send({ refreshToken: session.refreshToken });
      expect(refresh.status).toBe(403);
    });

    it('denies the access token BEFORE validating the body: a bad body is 400 but the token is dead', async () => {
      const session = await h.login(admin.email, PASSWORD);
      const res = await h.http().post(`${API}/auth/logout`).set(bearer(session)).send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        validationBody(
          'refreshToken must be longer than or equal to 1 characters',
          'refreshToken must be a string',
        ),
      );
      expect((await h.http().get(`${API}/plans`).set(bearer(session))).status).toBe(401);
    });

    it('an unknown refresh token is a silent no-op (still 204)', async () => {
      const session = await h.login(admin.email, PASSWORD);
      const res = await h
        .http()
        .post(`${API}/auth/logout`)
        .set(bearer(session))
        .send({ refreshToken: 'unknown' });
      expect(res.status).toBe(204);
    });

    it('401 without an access token', async () => {
      const res = await h.http().post(`${API}/auth/logout`).send({ refreshToken: 'x' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED);
    });
  });

  describe('authenticate(): the 401 bodies', () => {
    const sign = (secret: string, expiresIn: number) =>
      jwt.sign(
        {
          sub: admin.userId,
          organizationId: admin.organizationId,
          roles: ['org_admin'],
          jti: randomUUID(),
        },
        secret,
        { expiresIn },
      );

    it.each([
      ['no Authorization header', undefined],
      ['a non-Bearer scheme', 'Basic abc'],
      ['a garbage token', 'Bearer abc'],
      ['a token signed with another secret', () => `Bearer ${sign('other-secret', 60)}`],
      ['an expired token', () => `Bearer ${sign(process.env.JWT_SECRET!, -10)}`],
    ])('401 {message:"Unauthorized"} for %s', async (_label, header) => {
      const req = h.http().get(`${API}/users`);
      const value = typeof header === 'function' ? header() : header;
      const res = await (value ? req.set('Authorization', value) : req);
      expect(res.status).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED);
    });

    it('a well-formed token with valid claims is accepted', async () => {
      const res = await h
        .http()
        .get(`${API}/plans`)
        .set('Authorization', `Bearer ${sign(process.env.JWT_SECRET!, 60)}`);
      expect(res.status).toBe(200);
    });
  });

  describe('health probes', () => {
    it('GET /health — liveness, public and unthrottled', async () => {
      const res = await h.http().get(`${API}/health`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    });

    it('GET /health/ready — readiness reports the database', async () => {
      const res = await h.http().get(`${API}/health/ready`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', database: true });
    });
  });

  describe('app plumbing', () => {
    it("an unknown route falls through to Express's default HTML 404", async () => {
      const res = await h.http().get(`${API}/does-not-exist`);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('Cannot GET /api/v1/does-not-exist');
    });

    it('an unknown method on a known path is the same HTML 404', async () => {
      const res = await h.http().put(`${API}/plans`);
      expect(res.status).toBe(404);
      expect(res.text).toContain('Cannot PUT /api/v1/plans');
    });

    it('echoes a client x-correlation-id, and mints one when absent', async () => {
      const id = randomUUID();
      const echoed = await h.http().get(`${API}/health`).set('x-correlation-id', id);
      expect(echoed.headers['x-correlation-id']).toBe(id);

      const minted = await h.http().get(`${API}/health`);
      expect(minted.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('CORS: the allowlisted origin is reflected with credentials; others get no CORS headers', async () => {
      const allowed = await h.http().get(`${API}/health`).set('Origin', 'http://localhost:5178');
      expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5178');
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');

      const denied = await h.http().get(`${API}/health`).set('Origin', 'http://evil.example.com');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('helmet security headers are present', async () => {
      const res = await h.http().get(`${API}/health`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });
});
