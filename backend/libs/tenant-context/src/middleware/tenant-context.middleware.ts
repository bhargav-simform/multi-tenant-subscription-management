import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import {
  CORRELATION_ID_HEADER,
  INTERNAL_CONTEXT_HEADER,
  INTERNAL_SIGNATURE_HEADER,
} from '@app/common';
import { TenantContextStore } from '../store/tenant-context.store';
import { InternalContextSigner } from '../store/internal-context.signer';

/**
 * §26.4/§27.3: exact paths exempted from signature verification because Docker
 * Compose's healthcheck prober cannot produce a signed internal context. This
 * is a HARDCODED PATH exemption, not a decorator any route can opt into — a
 * developer cannot accidentally (or deliberately) exempt a business route by
 * adding a decorator. Both routes return liveness/readiness booleans only.
 */
const UNAUTHENTICATED_HEALTH_PATHS = new Set(['/health', '/health/ready']);

/**
 * Layer-1 origin check AND layer-2 transport, in one step (§13.2, §13.4, §10.5).
 *
 * BUG FIX (found via the frontend's dashboard/organizations-me integration —
 * every non-health request 500'd with "TenantContextStore.getOrThrow() called
 * outside a scoped request"): this class used to trust a `req.tenantContext`
 * that `InternalContextGuard` (a guard) was supposed to have already attached.
 * That never happened, because NestJS's request lifecycle is:
 *
 *     middleware → guards → interceptors (pre) → pipes → HANDLER → interceptors (post)
 *
 * (verified directly against @nestjs/core's RouterExecutionContext.create,
 * which runs `fnCanActivate` — ALL guards — to completion, THEN calls
 * `interceptorsConsumer.intercept`, which wraps pipes and the handler. Guards
 * never run inside an interceptor's scope, and middleware never runs inside a
 * guard's — there is no ordering of separate guard/middleware/interceptor
 * classes that opens an ALS scope before a SIBLING guard, like
 * CaslAbilityGuard, needs to read it. `AsyncLocalStorage.run(ctx, fn)` only
 * keeps its scope open for the duration of `fn`, and a guard cannot nest
 * inside another guard's `canActivate()` — so this class must both verify the
 * signed header AND open the scope itself, in the one place (middleware) that
 * actually wraps every guard, pipe, interceptor and handler that runs after
 * it. `InternalContextGuard` is no longer where this content lives; see its
 * own doc comment for what it does now — purely a second, redundant check.
 *
 * Rejects any request lacking a validly-signed, non-expired x-internal-context
 * header. This is what makes it impossible for a client to reach a service
 * directly and forge orgId (§10.5) — the check downstream services rely on to
 * trust `organizationId` for RLS.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly store: TenantContextStore,
    private readonly signer: InternalContextSigner,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    // §26.4: the ONLY path-based exemption in the system. A route that needs a
    // real exemption from signature verification requires a NEW path added to
    // this exact array — greppable and reviewable, unlike a decorator that
    // could be scattered across any controller.
    //
    // NOTE: `req.originalUrl`, not `req.path`. Nest mounts a `forRoutes('*')`
    // middleware in a way that makes Express rewrite `req.path`/`req.url` to
    // "/" INSIDE this middleware (verified directly — a probe middleware
    // logging both fields inside a real, running Nest app printed
    // `path: "/", originalUrl: "/health/ready"` for a request to
    // /health/ready). `req.path` is only reliable again once Nest's router has
    // actually matched a route, i.e. inside a guard — which is why
    // InternalContextGuard, a few lines away in this same library, correctly
    // uses `req.path` and this class must not copy that without checking.
    if (UNAUTHENTICATED_HEALTH_PATHS.has(req.originalUrl)) {
      next();
      return;
    }

    const payloadB64 = req.header(INTERNAL_CONTEXT_HEADER);
    const signature = req.header(INTERNAL_SIGNATURE_HEADER);
    const payload = this.signer.verify(payloadB64 ?? '', signature ?? '');

    if (!payload) {
      next(new UnauthorizedException('Missing or invalid internal context'));
      return;
    }

    // Correlation id may also arrive as its own header from the gateway; the
    // signed payload's copy is authoritative if both are present.
    req.headers[CORRELATION_ID_HEADER] = payload.correlationId;

    // The scope is open for every guard, pipe, interceptor and handler that
    // runs after `next()` resolves — including CaslAbilityGuard's
    // `getOrThrow()` call, which is exactly the call this fixes.
    this.store.run(payload, next);
  }
}
