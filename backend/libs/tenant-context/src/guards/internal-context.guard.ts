import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TenantContextStore } from '../store/tenant-context.store';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * DEFENSE IN DEPTH ONLY — a second, independent check that a scope exists,
 * NOT the mechanism that verifies the signed header or opens that scope.
 *
 * The actual signature verification and `TenantContextStore.run()` call both
 * moved into `TenantContextMiddleware` — see that class's doc comment for
 * why: guards run strictly before interceptors and strictly alongside their
 * sibling guards (nothing can open an ALS scope from inside one guard that a
 * SIBLING guard, like CaslAbilityGuard, can then read), so the only place in
 * NestJS's request lifecycle that can wrap every guard, pipe, interceptor and
 * handler in one open scope is middleware, which runs first.
 *
 * This guard still exists because "the scope is open" and "the caller may
 * proceed" are two different guarantees, and collapsing them into one file
 * would make a future refactor of either easy to break silently. If a route
 * is neither exempted by TenantContextMiddleware's hardcoded health-path list
 * NOR carries a scope, something upstream is broken in a way that must 401,
 * not silently fall through to CaslAbilityGuard's own `getOrThrow()` (which
 * would also catch it, but as a 500, not a 401 — the wrong status for "you
 * were never authenticated").
 *
 * `@Public()` is honoured here for parity with api-gateway's own guard
 * naming, though no downstream service controller actually applies it today
 * (§11.5: all three @Public() routes live in api-gateway; a downstream
 * service marking one of its own business routes @Public() would bypass this
 * check entirely and is a bug — §13.7 row 6).
 */
@Injectable()
export class InternalContextGuard implements CanActivate {
  constructor(
    private readonly store: TenantContextStore,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();

    // Mirrors TenantContextMiddleware's own exemption — a health path never
    // gets a scope opened for it, so this guard must not demand one either.
    if (req.path === '/health' || req.path === '/health/ready') return true;

    if (!this.store.get()) {
      throw new UnauthorizedException('Missing or invalid internal context');
    }
    return true;
  }
}
