import { resetThrottleState } from '../../src/middlewares/throttle';
import { API, HttpHarness, PASSWORD, bearer, type OrgAdminSession } from '../support/http-harness';

const TOO_MANY = { statusCode: 429, message: 'ThrottlerException: Too Many Requests' };

/**
 * Rate limiting (tests/setup-env.ts: default 100/60s, strict 10/60s). Fixed windows
 * per route handler + bucket + client IP; Reset and Retry-After are in MILLISECONDS
 * (the old Redis-backed @nestjs/throttler storage semantics). The strict bucket's
 * headers carry a "-strict" suffix.
 */
describe('HTTP contract: throttling', () => {
  const h = new HttpHarness();
  let admin: OrgAdminSession;

  beforeAll(async () => {
    await h.start();
    admin = await h.signup();
  });
  afterAll(() => h.stop());
  beforeEach(() => resetThrottleState());

  const badLogin = () =>
    h.http().post(`${API}/auth/login`).send({ email: 'nobody@example.com', password: 'x' });

  it('strict bucket (login): 10 allowed with -strict headers, the 11th is 429 with Retry-After-strict', async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await badLogin();
      expect(res.status).toBe(401);
      expect(res.headers['x-ratelimit-limit-strict']).toBe('10');
      expect(res.headers['x-ratelimit-remaining-strict']).toBe(String(10 - i));
      const reset = Number(res.headers['x-ratelimit-reset-strict']);
      expect(reset).toBeGreaterThan(0);
      expect(reset).toBeLessThanOrEqual(60_000);
      // The strict bucket replaces the default one on these routes.
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }

    const blocked = await badLogin();
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
    const retryAfter = Number(blocked.headers['retry-after-strict']);
    expect(retryAfter).toBeGreaterThan(59_000);
    expect(retryAfter).toBeLessThanOrEqual(60_000);
    expect(blocked.headers['x-ratelimit-remaining-strict']).toBeUndefined();

    // Blocked means blocked: even valid credentials are refused inside the window.
    const valid = await h
      .http()
      .post(`${API}/auth/login`)
      .send({ email: admin.email, password: PASSWORD });
    expect(valid.status).toBe(429);
  });

  it('buckets are per route: exhausting login leaves refresh and signup untouched', async () => {
    for (let i = 0; i < 11; i++) await badLogin();
    const refresh = await h.http().post(`${API}/auth/refresh`).send({ refreshToken: 'nope' });
    expect(refresh.status).toBe(401);
    expect(refresh.headers['x-ratelimit-remaining-strict']).toBe('9');

    const signup = await h.http().post(`${API}/onboarding/signup`).send({});
    expect(signup.status).toBe(400);
    expect(signup.headers['x-ratelimit-limit-strict']).toBe('10');
  });

  it('default bucket (authenticated routes): 100 allowed, the 101st is 429 with Retry-After', async () => {
    for (let i = 1; i <= 100; i++) {
      const res = await h.http().get(`${API}/plans`).set(bearer(admin));
      expect(res.status).toBe(200);
      if (i === 1 || i === 100) {
        expect(res.headers['x-ratelimit-limit']).toBe('100');
        expect(res.headers['x-ratelimit-remaining']).toBe(String(100 - i));
        expect(Number(res.headers['x-ratelimit-reset'])).toBeLessThanOrEqual(60_000);
      }
    }
    const blocked = await h.http().get(`${API}/plans`).set(bearer(admin));
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(59_000);

    // Another route still has its own budget.
    const other = await h.http().get(`${API}/subscriptions/current`).set(bearer(admin));
    expect(other.status).toBe(200);
    expect(other.headers['x-ratelimit-remaining']).toBe('99');
  });

  it('throttling runs before authentication: unauthenticated requests are counted and blocked too', async () => {
    for (let i = 0; i < 100; i++) await h.http().get(`${API}/users`);
    const res = await h.http().get(`${API}/users`);
    expect(res.status).toBe(429);
    expect(res.body).toEqual(TOO_MANY);
  });

  it('the health probes are never throttled and carry no rate-limit headers', async () => {
    for (let i = 0; i < 120; i++) {
      const res = await h.http().get(`${API}/health`);
      expect(res.status).toBe(200);
    }
    const ready = await h.http().get(`${API}/health/ready`);
    expect(ready.status).toBe(200);
    expect(ready.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('path matching is exact: a trailing slash or query string still hits the strict bucket', async () => {
    const slash = await h
      .http()
      .post(`${API}/auth/login/`)
      .send({ email: 'x@example.com', password: 'x' });
    expect(slash.headers['x-ratelimit-limit-strict']).toBe('10');
    const query = await h
      .http()
      .post(`${API}/auth/login?x=1`)
      .send({ email: 'x@example.com', password: 'x' });
    expect(query.headers['x-ratelimit-limit-strict']).toBe('10');
  });
});
