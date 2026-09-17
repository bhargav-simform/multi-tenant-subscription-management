import { jest, describe, it, expect } from '@jest/globals';
import { Reflector } from '@nestjs/core';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { TenantContextStore } from '../../store/tenant-context.store';
import { InternalContextGuard } from '../internal-context.guard';

/**
 * InternalContextGuard is defense-in-depth ONLY now — TenantContextMiddleware
 * verifies the signed header and opens the ALS scope before any guard runs
 * (see that class's doc comment). These tests assert exactly that reduced
 * contract: this guard reads the STORE, never `req`, and never opens
 * anything itself.
 */
describe('InternalContextGuard', () => {
  function buildContext(path = '/organizations/me', isPublic = false): {
    context: ExecutionContext;
    reflector: Reflector;
  } {
    const reflector = { getAllAndOverride: jest.fn(() => isPublic) } as unknown as Reflector;
    const req = { path };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    return { context, reflector };
  }

  it('allows a request when the ALS scope is already open (middleware did its job)', () => {
    const store = new TenantContextStore();
    const { context, reflector } = buildContext();
    const guard = new InternalContextGuard(store, reflector);

    const result = store.run(
      { userId: 'u1', organizationId: 'org-1', roles: [], correlationId: 'c1' },
      () => guard.canActivate(context),
    );

    expect(result).toBe(true);
  });

  it('rejects a request with no open scope on a non-exempt path', () => {
    const store = new TenantContextStore();
    const { context, reflector } = buildContext();
    const guard = new InternalContextGuard(store, reflector);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('exempts /health and /health/ready with no scope required', () => {
    const store = new TenantContextStore();
    const guard = new InternalContextGuard(store, buildContext('/health').reflector);

    expect(guard.canActivate(buildContext('/health').context)).toBe(true);
    expect(guard.canActivate(buildContext('/health/ready').context)).toBe(true);
  });

  it('honours @Public() metadata for parity with api-gateway, though no downstream route uses it today', () => {
    const store = new TenantContextStore();
    const { context, reflector } = buildContext('/organizations/me', true);
    const guard = new InternalContextGuard(store, reflector);

    expect(guard.canActivate(context)).toBe(true);
  });
});
