import { jest, describe, it, expect } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantContextStore } from '../../store/tenant-context.store';
import { InternalContextSigner } from '../../store/internal-context.signer';
import { TenantContextMiddleware } from '../tenant-context.middleware';

/**
 * The regression this file exists to prevent: TenantContextMiddleware used to
 * trust `req.tenantContext`, a field only a GUARD ever set — but NestJS runs
 * every middleware before every guard, so that field was always undefined and
 * `store.run()` was never called on any real request. Every assertion below
 * therefore checks the scope from INSIDE the downstream call (`next`), the
 * same discipline tenant-context.interceptor.spec.ts uses for the gateway's
 * equivalent class — "next was called" would pass in the broken state just as
 * easily as "store.run was called" would have.
 */
describe('TenantContextMiddleware', () => {
  function buildSigner(): InternalContextSigner {
    const config = { getOrThrow: () => 'test-secret', get: () => '30' };
    return new InternalContextSigner(config as never);
  }

  /**
   * `path` is set to the WRONG value on purpose, matching what a real Nest app
   * actually delivers to a `forRoutes('*')` middleware: Express rewrites
   * `req.path`/`req.url` to "/" inside that middleware layer (verified against
   * a real running app — see the class's own doc comment), and only
   * `req.originalUrl` still holds the real request path. A test double that
   * set `path` correctly and left `originalUrl` wrong would hide this exact
   * bug, so both fields are given deliberately DIFFERENT values here.
   */
  function buildRequest(overrides: Partial<Request> = {}): Request {
    const headers: Record<string, string> = {};
    return {
      path: '/',
      originalUrl: '/organizations/me',
      header: (name: string) => headers[name.toLowerCase()],
      headers,
      ...overrides,
    } as unknown as Request;
  }

  function sign(signer: InternalContextSigner, organizationId: string | null = 'org-1') {
    return signer.sign({
      userId: organizationId ? 'user-1' : null,
      organizationId,
      roles: organizationId ? ['org_admin'] : [],
      correlationId: 'corr-1',
    });
  }

  it('opens an ALS scope that is still open inside the downstream handler', () => {
    const store = new TenantContextStore();
    const signer = buildSigner();
    const middleware = new TenantContextMiddleware(store, signer);
    const { payloadB64, signature } = sign(signer);

    let seen: unknown;
    const req = buildRequest({
      header: (name: string) =>
        ({ 'x-internal-context': payloadB64, 'x-internal-signature': signature })[
          name.toLowerCase()
        ],
      headers: {},
    });

    middleware.use(req, {} as Response, () => {
      seen = store.get();
    });

    expect(seen).toBeDefined();
    expect((seen as { organizationId: string | null }).organizationId).toBe('org-1');
  });

  it('rejects a request with no signed header — never falls through unauthenticated', () => {
    const store = new TenantContextStore();
    const middleware = new TenantContextMiddleware(store, buildSigner());
    const req = buildRequest();
    const next = jest.fn();

    middleware.use(req, {} as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a tampered signature', () => {
    const store = new TenantContextStore();
    const signer = buildSigner();
    const middleware = new TenantContextMiddleware(store, signer);
    const { payloadB64 } = sign(signer);
    const next = jest.fn();

    const req = buildRequest({
      header: (name: string) =>
        ({ 'x-internal-context': payloadB64, 'x-internal-signature': 'deadbeef'.repeat(8) })[
          name.toLowerCase()
        ],
    });

    middleware.use(req, {} as Response, next);

    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthorizedException);
  });

  it('exempts exactly /health and /health/ready, opening no scope and requiring no signature', () => {
    const store = new TenantContextStore();
    const middleware = new TenantContextMiddleware(store, buildSigner());

    for (const originalUrl of ['/health', '/health/ready']) {
      const next = jest.fn();
      middleware.use(buildRequest({ originalUrl }), {} as Response, next);
      expect(next).toHaveBeenCalledWith(); // called with no error argument
    }
  });

  it('does NOT exempt a path that merely starts with /health', () => {
    const store = new TenantContextStore();
    const middleware = new TenantContextMiddleware(store, buildSigner());
    const next = jest.fn();

    middleware.use(buildRequest({ originalUrl: '/health/anything-else' }), {} as Response, next);

    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(UnauthorizedException);
  });

  /**
   * THE regression this whole file exists to prevent, encoded directly: if
   * this class ever goes back to reading `req.path` for the health-path
   * exemption, this test fails, because `path` here is deliberately "/" (as a
   * real forRoutes('*') middleware actually receives) while `originalUrl` is
   * the real, exempted health path.
   */
  it('reads req.originalUrl for the health-path exemption, never req.path', () => {
    const store = new TenantContextStore();
    const middleware = new TenantContextMiddleware(store, buildSigner());
    const next = jest.fn();

    middleware.use(
      buildRequest({ path: '/', originalUrl: '/health/ready' }),
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it('carries organizationId null through for a platform admin (§13.6)', () => {
    const store = new TenantContextStore();
    const signer = buildSigner();
    const middleware = new TenantContextMiddleware(store, signer);
    const { payloadB64, signature } = sign(signer, null);

    let seen: { organizationId: string | null } | undefined;
    const req = buildRequest({
      header: (name: string) =>
        ({ 'x-internal-context': payloadB64, 'x-internal-signature': signature })[
          name.toLowerCase()
        ],
    });

    middleware.use(req, {} as Response, () => {
      seen = store.get();
    });

    expect(seen?.organizationId).toBeNull();
  });

  it('closes the scope once the downstream call returns — no leak to the next request', () => {
    const store = new TenantContextStore();
    const signer = buildSigner();
    const middleware = new TenantContextMiddleware(store, signer);
    const { payloadB64, signature } = sign(signer);

    const req = buildRequest({
      header: (name: string) =>
        ({ 'x-internal-context': payloadB64, 'x-internal-signature': signature })[
          name.toLowerCase()
        ],
    });

    middleware.use(req, {} as Response, () => {});

    expect(store.get()).toBeUndefined();
  });
});
