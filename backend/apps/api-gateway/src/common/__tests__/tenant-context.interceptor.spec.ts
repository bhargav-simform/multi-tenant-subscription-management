import { jest, describe, it, expect } from '@jest/globals';
import { firstValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { TenantContextStore } from '@app/tenant-context';
import { CORRELATION_ID_HEADER, Role, type TenantContextPayload } from '@app/common';
import type { JwtAccessPayload } from '@app/auth';
import { TenantContextInterceptor } from '../tenant-context.interceptor';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const CORRELATION_ID = 'corr-abc';

/**
 * §11.3/§13.3: the JWT → trusted-internal-context translation — the single reason
 * this service exists. These tests are written to fail if the mechanism is broken in
 * the way that is EASIEST to break it and HARDEST to notice: an ALS scope that is
 * opened and then closed again before the handler runs (what a guard would do — see
 * the interceptor's own doc comment). Asserting merely that `store.run` was called
 * would pass in that broken state, so every assertion below reads the scope from
 * INSIDE the handler, at the moment a downstream call would actually be signed.
 */
describe('TenantContextInterceptor', () => {
  function buildContext(user?: JwtAccessPayload, correlationId = CORRELATION_ID) {
    const req = {
      user,
      header: (name: string) =>
        name === CORRELATION_ID_HEADER ? correlationId : undefined,
    };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  function makePayload(overrides: Partial<JwtAccessPayload> = {}): JwtAccessPayload {
    return {
      sub: USER_ID,
      organizationId: ORG_ID,
      roles: [Role.ORG_ADMIN],
      jti: 'jti-1',
      iat: 1_700_000_000,
      exp: 1_700_000_900,
      ...overrides,
    };
  }

  /**
   * Stands in for a controller handler making a downstream call. It captures what
   * TenantContextStore.get() returns AT CALL TIME — exactly what InternalHttpClient
   * reads when it decides whether to propagate an identity or sign anonymous (§9.4).
   */
  function handlerCapturing(store: TenantContextStore): {
    handler: CallHandler;
    seen: () => TenantContextPayload | undefined;
  } {
    let captured: TenantContextPayload | undefined;
    const handler: CallHandler = {
      handle: () => {
        captured = store.get();
        return of('handler-result');
      },
    };
    return { handler, seen: () => captured };
  }

  it('opens an ALS scope that is still open when the handler makes a downstream call', async () => {
    const store = new TenantContextStore();
    const interceptor = new TenantContextInterceptor(store);
    const { handler, seen } = handlerCapturing(store);

    await firstValueFrom(
      interceptor.intercept(buildContext(makePayload()), handler),
    );

    // The whole point: not "run was called", but "the scope was OPEN at call time".
    expect(seen()).toBeDefined();
  });

  it('shapes the context from the verified JWT claims and nothing else', async () => {
    const store = new TenantContextStore();
    const interceptor = new TenantContextInterceptor(store);
    const { handler, seen } = handlerCapturing(store);

    await firstValueFrom(
      interceptor.intercept(buildContext(makePayload()), handler),
    );

    expect(seen()).toEqual({
      userId: USER_ID,
      organizationId: ORG_ID,
      roles: [Role.ORG_ADMIN],
      correlationId: CORRELATION_ID,
      iat: 1_700_000_000,
      exp: 1_700_000_900,
    });
  });

  it('carries organizationId null through for a platform admin (§11.3, §13.6)', async () => {
    const store = new TenantContextStore();
    const interceptor = new TenantContextInterceptor(store);
    const { handler, seen } = handlerCapturing(store);

    await firstValueFrom(
      interceptor.intercept(
        buildContext(
          makePayload({ organizationId: null, roles: [Role.PLATFORM_ADMIN] }),
        ),
        handler,
      ),
    );

    // Null, not undefined and not omitted: a null app.current_org is what makes every
    // RLS policy evaluate false for a platform admin (§13.6). Coercing it to a real
    // org id anywhere in this chain would hand them another tenant's content.
    expect(seen()?.organizationId).toBeNull();
    expect(seen()?.roles).toEqual([Role.PLATFORM_ADMIN]);
  });

  it('opens NO scope for a public route, so InternalHttpClient signs anonymous (§9.4)', async () => {
    const store = new TenantContextStore();
    const interceptor = new TenantContextInterceptor(store);
    const { handler, seen } = handlerCapturing(store);

    // No req.user — JwtAuthGuard let this through as @Public().
    await firstValueFrom(
      interceptor.intercept(buildContext(undefined), handler),
    );

    // undefined, NOT a null-valued context object. InternalHttpClient branches on
    // `ctx ? propagate : signAnonymous`, so undefined is what routes /auth/login and
    // /onboarding/signup down the anonymous branch.
    expect(seen()).toBeUndefined();
  });

  it('never invents an identity when the JWT payload is absent', async () => {
    const store = new TenantContextStore();
    const runSpy = jest.spyOn(store, 'run');
    const interceptor = new TenantContextInterceptor(store);

    await firstValueFrom(
      interceptor.intercept(buildContext(undefined), {
        handle: () => of('x'),
      }),
    );

    expect(runSpy).not.toHaveBeenCalled();
  });

  it('closes the scope once the request completes, so it cannot leak to the next one', async () => {
    const store = new TenantContextStore();
    const interceptor = new TenantContextInterceptor(store);

    await firstValueFrom(
      interceptor.intercept(buildContext(makePayload()), {
        handle: () => of('x'),
      }),
    );

    // A context surviving past its own request would be a cross-tenant leak of the
    // worst kind: the NEXT caller inherits the previous caller's orgId.
    expect(store.get()).toBeUndefined();
  });

  it('isolates concurrent requests from each other', async () => {
    const store = new TenantContextStore();
    const interceptor = new TenantContextInterceptor(store);

    const ORG_B = '33333333-3333-3333-3333-333333333333';

    /** Yields to the event loop mid-handler, interleaving the two requests. */
    async function run(orgId: string): Promise<string | null | undefined> {
      let seen: string | null | undefined;
      const handler: CallHandler = {
        handle: () =>
          of(null).pipe(() => {
            seen = store.get()?.organizationId;
            return of('x');
          }),
      };
      const result = interceptor.intercept(
        buildContext(makePayload({ organizationId: orgId })),
        handler,
      );
      await firstValueFrom(result);
      await new Promise((resolve) => setImmediate(resolve));
      return seen;
    }

    const [a, b] = await Promise.all([run(ORG_ID), run(ORG_B)]);

    expect(a).toBe(ORG_ID);
    expect(b).toBe(ORG_B);
  });
});
