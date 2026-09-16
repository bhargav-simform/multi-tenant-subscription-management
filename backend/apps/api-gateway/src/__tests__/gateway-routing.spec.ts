import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { HttpService } from '@nestjs/axios';
import type { AxiosResponse } from 'axios';
import { of } from 'rxjs';
import request from 'supertest';
import {
  TenantContextStore,
  InternalContextSigner,
  InternalHttpClient,
} from '@app/tenant-context';
import {
  JwtAuthGuard,
  JwtStrategy,
  TOKEN_DENYLIST,
  type TokenDenylist,
  type JwtAccessPayload,
} from '@app/auth';
import {
  CORRELATION_ID_HEADER,
  INTERNAL_CONTEXT_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  Role,
  type TenantContextPayload,
} from '@app/common';
import { CorrelationIdMiddleware } from '@app/logging';
import { ProxyService } from '../proxy/proxy.service';
import { DownstreamConfig } from '../proxy/downstream.config';
import { TenantContextInterceptor } from '../common/tenant-context.interceptor';
import { PlatformAdminGuard } from '../common/platform-admin.guard';
import { AuthController } from '../auth/auth.controller';
import { OnboardingController } from '../onboarding/onboarding.controller';
import { InvitationsController } from '../invitations/invitations.controller';
import { OrganizationsController } from '../organizations/organizations.controller';
import { UsersController } from '../users/users.controller';
import { SubscriptionsController } from '../subscriptions/subscriptions.controller';
import { ResourcesController } from '../resources/resources.controller';
import { AuditController } from '../audit/audit.controller';
import { DashboardController } from '../dashboard/dashboard.controller';

const JWT_SECRET = 'test-jwt-secret-value';
const INTERNAL_SECRET = 'test-internal-signing-secret';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';

/** Minimal HS256 JWT, so this suite proves real signature verification, not a mock of it. */
function signJwt(payload: Record<string, unknown>, secret = JWT_SECRET): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function accessToken(overrides: Partial<JwtAccessPayload> = {}, secret = JWT_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      sub: USER_ID,
      organizationId: ORG_ID,
      roles: [Role.ORG_ADMIN],
      jti: 'jti-test',
      iat: now,
      exp: now + 900,
      ...overrides,
    },
    secret,
  );
}

interface CapturedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  params?: Record<string, unknown>;
}

/**
 * §10, §11.5: the gateway's entire reason for existing, exercised through a real
 * NestJS HTTP stack (real JwtAuthGuard, real passport-jwt verification, real
 * InternalHttpClient) with only the OUTBOUND socket and Redis faked. Nothing here
 * mocks the auth decision itself — a broken guard registration, a missing @Public(),
 * or a scope that closes too early all fail these tests.
 */
describe('api-gateway routing and authentication', () => {
  let app: INestApplication;
  let calls: CapturedCall[];
  let denied: Array<{ jti: string; ttl: number }>;
  let nextStatus: number;
  let nextBody: unknown;

  beforeAll(async () => {
    calls = [];
    denied = [];
    nextStatus = 200;
    nextBody = { ok: true };

    /** Captures the outgoing request instead of opening a socket. */
    const fakeHttpService = {
      get: (url: string, config?: Record<string, unknown>) =>
        record('GET', url, undefined, config),
      post: (url: string, data?: unknown, config?: Record<string, unknown>) =>
        record('POST', url, data, config),
      patch: (url: string, data?: unknown, config?: Record<string, unknown>) =>
        record('PATCH', url, data, config),
      delete: (url: string, config?: Record<string, unknown>) =>
        record('DELETE', url, undefined, config),
    };

    function record(
      method: string,
      url: string,
      body: unknown,
      config?: Record<string, unknown>,
    ) {
      calls.push({
        method,
        url,
        headers: (config?.headers ?? {}) as Record<string, string>,
        body,
        params: config?.params as Record<string, unknown> | undefined,
      });
      return of({
        status: nextStatus,
        data: nextBody,
        statusText: 'OK',
        headers: {},
        config: {},
      } as unknown as AxiosResponse);
    }

    const fakeDenylist: TokenDenylist = {
      isDenied: jest.fn(async (jti: string) => jti === 'revoked-jti'),
      deny: jest.fn(async (jti: string, ttl: number) => {
        denied.push({ jti, ttl });
      }),
    };

    /**
     * Mirrors AppModule's wiring exactly for everything that decides auth: the same
     * two controllers' decorators, the same global JwtAuthGuard, the same interceptor,
     * the same JwtStrategy. ThrottlerGuard and its Redis storage are omitted
     * deliberately: rate limiting is orthogonal to the auth decisions under test, and
     * including it would make these assertions order-dependent as buckets fill across
     * the suite. Its route classification is covered separately in
     * common/__tests__/throttle-routes.spec.ts.
     */
    @Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET,
              INTERNAL_SIGNING_SECRET: INTERNAL_SECRET,
              AUTH_SERVICE_URL: 'http://auth-service:3002',
              TENANT_SERVICE_URL: 'http://tenant-service:3001',
              USER_SERVICE_URL: 'http://user-service:3003',
              SUBSCRIPTION_SERVICE_URL: 'http://subscription-service:3004',
              RESOURCE_SERVICE_URL: 'http://resource-service:3005',
              AUDIT_SERVICE_URL: 'http://audit-service:3006',
            }),
          ],
        }),
        PassportModule,
      ],
      controllers: [
        AuthController,
        OnboardingController,
        InvitationsController,
        OrganizationsController,
        UsersController,
        SubscriptionsController,
        ResourcesController,
        AuditController,
        DashboardController,
      ],
      providers: [
        { provide: HttpService, useValue: fakeHttpService },
        { provide: TOKEN_DENYLIST, useValue: fakeDenylist },
        TenantContextStore,
        InternalContextSigner,
        InternalHttpClient,
        JwtStrategy,
        ProxyService,
        DownstreamConfig,
        PlatformAdminGuard,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    })
    class TestGatewayModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [TestGatewayModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(new CorrelationIdMiddleware().use.bind(new CorrelationIdMiddleware()));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  function reset(): void {
    calls.length = 0;
    denied.length = 0;
    nextStatus = 200;
    nextBody = { ok: true };
  }

  /** Decodes the x-internal-context the gateway actually put on the wire. */
  function lastSignedContext(): TenantContextPayload {
    const call = calls.at(-1);
    if (!call) throw new Error('no downstream call was made');
    const b64 = call.headers[INTERNAL_CONTEXT_HEADER];
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as TenantContextPayload;
  }

  // ---------------------------------------------------------------------------
  // §11.5: exactly three public routes, everything else authenticated.
  // ---------------------------------------------------------------------------

  describe('the three @Public() routes (§11.5)', () => {
    it.each([
      ['/api/v1/onboarding/signup', 'post' as const],
      ['/api/v1/auth/login', 'post' as const],
      ['/api/v1/invitations/some-token/accept', 'post' as const],
    ])('%s is reachable with NO Authorization header', async (path, method) => {
      reset();
      const res = await request(app.getHttpServer())[method](path).send({});
      expect(res.status).toBeLessThan(400);
      expect(calls).toHaveLength(1);
    });

    it('signs an ANONYMOUS context for a public route — never a fabricated identity (§9.4)', async () => {
      reset();
      await request(app.getHttpServer()).post('/api/v1/auth/login').send({
        email: 'a@b.com',
        password: 'x',
      });

      const ctx = lastSignedContext();
      expect(ctx.userId).toBeNull();
      expect(ctx.organizationId).toBeNull();
      expect(ctx.roles).toEqual([]);
    });

    it('still signs public routes, so downstream InternalContextGuard accepts them', async () => {
      reset();
      await request(app.getHttpServer()).post('/api/v1/onboarding/signup').send({});

      const call = calls.at(-1)!;
      // The fix this service was built against: tenant-service/user-service no longer
      // carry tenant-context's Public(), so an UNSIGNED call here would 401 at runtime
      // while passing every test that mocks the client interface (§32.4's lesson).
      expect(call.headers[INTERNAL_CONTEXT_HEADER]).toBeTruthy();
      expect(call.headers[INTERNAL_SIGNATURE_HEADER]).toBeTruthy();

      const expected = createHmac('sha256', INTERNAL_SECRET)
        .update(call.headers[INTERNAL_CONTEXT_HEADER])
        .digest('hex');
      expect(call.headers[INTERNAL_SIGNATURE_HEADER]).toBe(expected);
    });

    it('/auth/refresh is public too — the caller holds a refresh token, not an access token', async () => {
      // Documented §11.5-vs-§8.1 discrepancy, resolved in AuthController's doc comment
      // and logged in ARCHITECTURE.md §32.3. Requiring a valid ACCESS token here would
      // make refresh impossible in the only case it is ever used: an expired one.
      reset();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'r' });

      expect(res.status).toBeLessThan(400);
      expect(lastSignedContext().userId).toBeNull();
    });
  });

  describe('every other route requires a valid access token', () => {
    const protectedRoutes: Array<[string, 'get' | 'post' | 'patch' | 'delete']> = [
      ['/api/v1/auth/logout', 'post'],
      ['/api/v1/organizations/me', 'get'],
      ['/api/v1/organizations', 'get'],
      ['/api/v1/organizations/some-id', 'get'],
      ['/api/v1/users', 'get'],
      ['/api/v1/users/some-id', 'get'],
      ['/api/v1/users/invite', 'post'],
      ['/api/v1/users/some-id/role', 'patch'],
      ['/api/v1/users/some-id', 'delete'],
      ['/api/v1/invitations/some-id', 'delete'],
      ['/api/v1/plans', 'get'],
      ['/api/v1/subscriptions/current', 'get'],
      ['/api/v1/subscriptions/change', 'post'],
      ['/api/v1/usage', 'get'],
      ['/api/v1/resources', 'get'],
      ['/api/v1/resources', 'post'],
      ['/api/v1/resources/some-id', 'get'],
      ['/api/v1/resources/some-id', 'delete'],
      ['/api/v1/audit', 'get'],
      ['/api/v1/audit/security', 'get'],
      ['/api/v1/dashboard', 'get'],
    ];

    it.each(protectedRoutes)('%s %s → 401 with no Authorization header', async (path, method) => {
      reset();
      const res = await request(app.getHttpServer())[method](path).send({});
      expect(res.status).toBe(401);
      // Critically: no downstream hop was made for an unauthenticated caller.
      expect(calls).toHaveLength(0);
    });

    it('401s a token signed with the wrong secret', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .get('/api/v1/organizations/me')
        .set('Authorization', `Bearer ${accessToken({}, 'attacker-secret')}`);
      expect(res.status).toBe(401);
      expect(calls).toHaveLength(0);
    });

    it('401s an expired token', async () => {
      reset();
      const now = Math.floor(Date.now() / 1000);
      const res = await request(app.getHttpServer())
        .get('/api/v1/organizations/me')
        .set('Authorization', `Bearer ${accessToken({ iat: now - 3600, exp: now - 60 })}`);
      expect(res.status).toBe(401);
      expect(calls).toHaveLength(0);
    });

    it('401s a structurally valid token whose jti is on the Redis denylist (§16.2)', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .get('/api/v1/organizations/me')
        .set('Authorization', `Bearer ${accessToken({ jti: 'revoked-jti' })}`);
      expect(res.status).toBe(401);
      expect(calls).toHaveLength(0);
    });

    it('401s a malformed Authorization header', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .get('/api/v1/organizations/me')
        .set('Authorization', 'Bearer not-a-jwt');
      expect(res.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // §11.3/§13.3: the translation, observed on the actual wire.
  // ---------------------------------------------------------------------------

  describe('JWT → signed internal context, end to end', () => {
    it('signs the caller identity from the token onto the downstream call', async () => {
      reset();
      await request(app.getHttpServer())
        .get('/api/v1/organizations/me')
        .set('Authorization', `Bearer ${accessToken()}`);

      const ctx = lastSignedContext();
      expect(ctx.userId).toBe(USER_ID);
      expect(ctx.organizationId).toBe(ORG_ID);
      expect(ctx.roles).toEqual([Role.ORG_ADMIN]);
    });

    it('propagates a client-supplied correlation id to the downstream call (§26.2)', async () => {
      reset();
      await request(app.getHttpServer())
        .get('/api/v1/organizations/me')
        .set('Authorization', `Bearer ${accessToken()}`)
        .set(CORRELATION_ID_HEADER, 'client-corr-id');

      expect(lastSignedContext().correlationId).toBe('client-corr-id');
    });

    it('mints a correlation id when the client supplies none', async () => {
      reset();
      await request(app.getHttpServer())
        .get('/api/v1/organizations/me')
        .set('Authorization', `Bearer ${accessToken()}`);

      expect(lastSignedContext().correlationId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('IGNORES a client-supplied x-internal-context — orgId comes only from the token (§13.3)', async () => {
      reset();
      const forged = Buffer.from(
        JSON.stringify({ userId: 'evil', organizationId: 'victim-org', roles: [] }),
      ).toString('base64');

      await request(app.getHttpServer())
        .get('/api/v1/organizations/me')
        .set('Authorization', `Bearer ${accessToken()}`)
        .set(INTERNAL_CONTEXT_HEADER, forged)
        .set(INTERNAL_SIGNATURE_HEADER, 'whatever');

      // The gateway MINTS this header; it never forwards a client's copy. If it did,
      // a caller could name any organisation and read it.
      const ctx = lastSignedContext();
      expect(ctx.organizationId).toBe(ORG_ID);
      expect(ctx.userId).toBe(USER_ID);
    });

    it('signs organizationId null for a platform admin (§13.6)', async () => {
      reset();
      await request(app.getHttpServer())
        .get('/api/v1/organizations')
        .set(
          'Authorization',
          `Bearer ${accessToken({ organizationId: null, roles: [Role.PLATFORM_ADMIN] })}`,
        );

      expect(lastSignedContext().organizationId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // §10.2 coarse authorisation.
  // ---------------------------------------------------------------------------

  describe('coarse platform-admin gate (§10.2)', () => {
    it('403s an org admin on GET /organizations before any downstream hop', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .get('/api/v1/organizations')
        .set('Authorization', `Bearer ${accessToken()}`);

      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it('403s an org admin on GET /organizations/:id', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .get('/api/v1/organizations/other-org')
        .set('Authorization', `Bearer ${accessToken()}`);
      expect(res.status).toBe(403);
    });

    it('403s an org member on GET /usage — the only gate on that internal route', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .get('/api/v1/usage')
        .set('Authorization', `Bearer ${accessToken({ roles: [Role.ORG_MEMBER] })}`);
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it('lets a platform admin through to the downstream service', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .get('/api/v1/organizations')
        .set(
          'Authorization',
          `Bearer ${accessToken({ organizationId: null, roles: [Role.PLATFORM_ADMIN] })}`,
        );

      expect(res.status).toBe(200);
      expect(calls.at(-1)?.url).toBe('http://tenant-service:3001/organizations');
    });

    it('does NOT gate /organizations/me — any authenticated role may read their own org', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .get('/api/v1/organizations/me')
        .set('Authorization', `Bearer ${accessToken({ roles: [Role.ORG_MEMBER] })}`);
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // §11.4/§16.2 logout — the specific mechanism immediate revocation depends on.
  // ---------------------------------------------------------------------------

  describe('logout denylists the CALLER’s own access token (§11.4, §16.2)', () => {
    it('denies exactly the jti from the caller’s verified token', async () => {
      reset();
      const now = Math.floor(Date.now() / 1000);
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set(
          'Authorization',
          `Bearer ${accessToken({ jti: 'caller-own-jti', iat: now, exp: now + 900 })}`,
        )
        .send({ refreshToken: 'r' });

      expect(denied).toHaveLength(1);
      // The caller's OWN jti — not a body value, not a query param, not another
      // user's. Anything else would let one caller revoke another's session.
      expect(denied[0].jti).toBe('caller-own-jti');
    });

    it('uses the token’s REMAINING ttl, not a fixed value', async () => {
      reset();
      const now = Math.floor(Date.now() / 1000);
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken({ iat: now, exp: now + 300 })}`)
        .send({ refreshToken: 'r' });

      // ~300s: an entry outliving its token wastes Redis; one expiring early reopens
      // the window logout exists to close.
      expect(denied[0].ttl).toBeGreaterThan(290);
      expect(denied[0].ttl).toBeLessThanOrEqual(300);
    });

    it('denylists BEFORE forwarding, so a downstream failure still kills the token', async () => {
      reset();
      const denyOrder: string[] = [];
      const originalPush = denied.push.bind(denied);
      denied.push = ((...args: Array<{ jti: string; ttl: number }>) => {
        denyOrder.push('deny');
        return originalPush(...args);
      }) as typeof denied.push;

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken()}`)
        .send({ refreshToken: 'r' });

      denied.push = originalPush;
      expect(denyOrder).toEqual(['deny']);
      expect(calls).toHaveLength(1);
    });

    it('does not denylist anything on an unauthenticated logout attempt', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .send({ refreshToken: 'r' });

      expect(res.status).toBe(401);
      expect(denied).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // §10.3/§10.4 routing behaviour.
  // ---------------------------------------------------------------------------

  describe('pass-through routing (§10.3)', () => {
    it.each([
      ['get', '/api/v1/plans', 'http://subscription-service:3004/plans'],
      [
        'get',
        '/api/v1/subscriptions/current',
        'http://subscription-service:3004/subscriptions/current',
      ],
      ['get', '/api/v1/resources', 'http://resource-service:3005/resources'],
      ['get', '/api/v1/audit', 'http://audit-service:3006/audit'],
      ['get', '/api/v1/audit/security', 'http://audit-service:3006/audit/security'],
      ['get', '/api/v1/users', 'http://user-service:3003/users'],
    ])('%s %s → %s', async (method, path, expectedUrl) => {
      reset();
      await request(app.getHttpServer())
        [method as 'get'](path)
        .set('Authorization', `Bearer ${accessToken()}`);
      expect(calls.at(-1)?.url).toBe(expectedUrl);
    });

    it('forwards the query string untouched', async () => {
      reset();
      await request(app.getHttpServer())
        .get('/api/v1/users?limit=10&cursor=abc')
        .set('Authorization', `Bearer ${accessToken()}`);

      expect(calls.at(-1)?.params).toEqual({ limit: '10', cursor: 'abc' });
    });

    it('forwards the body untouched, without revalidating a downstream DTO', async () => {
      reset();
      const body = { name: 'report.pdf', sizeBytes: 1234, somethingNew: true };
      await request(app.getHttpServer())
        .post('/api/v1/resources')
        .set('Authorization', `Bearer ${accessToken()}`)
        .send(body);

      // §10.3: the gateway holds no opinion about a resource's shape. A whitelist
      // ValidationPipe here would silently strip a field the downstream service needs.
      expect(calls.at(-1)?.body).toEqual(body);
    });

    it('passes a downstream 404 through unchanged (H1: cross-tenant read-by-id)', async () => {
      reset();
      nextStatus = 404;
      nextBody = { statusCode: 404, message: 'Resource not found' };
      const err = Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 404, data: nextBody },
      });
      jest
        .spyOn(app.get(InternalHttpClient), 'get')
        .mockRejectedValueOnce(err as never);

      const res = await request(app.getHttpServer())
        .get('/api/v1/resources/foreign-id')
        .set('Authorization', `Bearer ${accessToken()}`);

      // Collapsing this into a 500 would destroy the cross-tenant contract: the
      // client must be unable to tell "another org's row" from "no such row".
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ statusCode: 404, message: 'Resource not found' });
    });

    it('passes a downstream 409 plan-limit rejection through with its message (R6)', async () => {
      reset();
      const body = {
        statusCode: 409,
        message: 'Seat limit reached for plan free (5 of 5 seats used)',
        details: { limit: 5, used: 5 },
      };
      const err = Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 409, data: body },
      });
      jest
        .spyOn(app.get(InternalHttpClient), 'post')
        .mockRejectedValueOnce(err as never);

      const res = await request(app.getHttpServer())
        .post('/api/v1/users/invite')
        .set('Authorization', `Bearer ${accessToken()}`)
        .send({ email: 'a@b.com' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual(body);
    });

    it('returns 503, not 500, when a downstream service is unreachable', async () => {
      reset();
      const err = Object.assign(new Error('ECONNREFUSED'), { isAxiosError: true });
      jest
        .spyOn(app.get(InternalHttpClient), 'get')
        .mockRejectedValueOnce(err as never);

      const res = await request(app.getHttpServer())
        .get('/api/v1/plans')
        .set('Authorization', `Bearer ${accessToken()}`);

      expect(res.status).toBe(503);
    });

    it('404s an unknown route without a downstream hop (§10.2)', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .get('/api/v1/not-a-route')
        .set('Authorization', `Bearer ${accessToken()}`);
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    });
  });

  describe('the one aggregation case (§10.4)', () => {
    it('fans out to subscriptions/current and users?limit=5 in one response', async () => {
      reset();
      const res = await request(app.getHttpServer())
        .get('/api/v1/dashboard')
        .set('Authorization', `Bearer ${accessToken()}`);

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.url).sort()).toEqual([
        'http://subscription-service:3004/subscriptions/current',
        'http://user-service:3003/users',
      ]);
      expect(calls.find((c) => c.url.includes('user-service'))?.params).toEqual({
        limit: 5,
      });
      expect(res.body).toEqual({ subscription: { ok: true }, recentUsers: { ok: true } });
    });

    it('signs BOTH fan-out calls with the same identity and correlation id', async () => {
      reset();
      await request(app.getHttpServer())
        .get('/api/v1/dashboard')
        .set('Authorization', `Bearer ${accessToken()}`)
        .set(CORRELATION_ID_HEADER, 'fanout-corr');

      const contexts = calls.map(
        (c) =>
          JSON.parse(
            Buffer.from(c.headers[INTERNAL_CONTEXT_HEADER], 'base64').toString('utf8'),
          ) as TenantContextPayload,
      );

      expect(contexts).toHaveLength(2);
      // The ALS scope must survive across a Promise.all fan-out — if it did not, the
      // second call would be signed ANONYMOUS and silently read nothing.
      for (const ctx of contexts) {
        expect(ctx.organizationId).toBe(ORG_ID);
        expect(ctx.userId).toBe(USER_ID);
        expect(ctx.correlationId).toBe('fanout-corr');
      }
    });
  });
});
