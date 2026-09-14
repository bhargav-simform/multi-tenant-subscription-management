import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  INTERNAL_CONTEXT_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  CORRELATION_ID_HEADER,
} from '@app/common';
import { InternalContextSigner } from '../store/internal-context.signer';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * §26.4/§27.3: exact paths exempted from signature verification because Docker
 * Compose's healthcheck prober cannot produce a signed internal context. This
 * is a HARDCODED PATH exemption, not a decorator any route can opt into — a
 * developer cannot accidentally (or deliberately) exempt a business route by
 * adding a decorator, unlike a @Public()-style mechanism would allow. Both
 * routes return liveness/readiness booleans only — no tenant data, no
 * business logic, nothing an exemption here could leak (§13.7 row 6's mistake
 * would need a NEW path added to this exact array, which is greppable and
 * reviewable in a way a decorator scattered across the codebase is not).
 */
const UNAUTHENTICATED_HEALTH_PATHS = ['/health', '/health/ready'];

/**
 * Layer-1 origin check (§13.2 step 5, §10.5). Runs in EVERY downstream service as a
 * global APP_GUARD. Rejects any request lacking a validly-signed, non-expired
 * x-internal-context header — this is what makes it impossible for a client to
 * reach a service directly and forge orgId (§10.5).
 *
 * On success, attaches the verified payload to the request for
 * TenantContextMiddleware to pick up. Does NOT itself open the ALS scope — that is
 * the middleware's job, so guard and middleware stay independently testable.
 */
@Injectable()
export class InternalContextGuard implements CanActivate {
  constructor(
    private readonly signer: InternalContextSigner,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Public routes (§11.5 — exactly three, all live in api-gateway) skip THIS
    // guard's check entirely, because they run inside api-gateway itself, which
    // has no InternalContextGuard of its own (it has JwtAuthGuard instead).
    //
    // Every downstream service (auth-service included) still verifies a signed
    // context on 100% of its BUSINESS routes below — even /auth/login, which
    // has no authenticated identity yet, is signed as an ANONYMOUS context by
    // the gateway (§9.4) and verified exactly like any other. A downstream
    // service must NEVER mark a business route @Public() itself; if one does,
    // it bypasses the one uniform bypass-prevention mechanism the whole
    // system relies on, and must be caught in review (§13.7 row 6).
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();

    // §26.4: the ONLY path-based exemption in the system. See
    // UNAUTHENTICATED_HEALTH_PATHS above for why this is safe and why it is
    // shaped this way rather than as a decorator.
    if (UNAUTHENTICATED_HEALTH_PATHS.includes(req.path)) return true;

    const payloadB64 = req.header(INTERNAL_CONTEXT_HEADER);
    const signature = req.header(INTERNAL_SIGNATURE_HEADER);

    const payload = this.signer.verify(payloadB64 ?? '', signature ?? '');
    if (!payload) {
      throw new UnauthorizedException('Missing or invalid internal context');
    }

    // Correlation id may also arrive as its own header from the gateway; the signed
    // payload's copy is authoritative if both are present.
    req.headers[CORRELATION_ID_HEADER] = payload.correlationId;
    (req as Request & { tenantContext: typeof payload }).tenantContext = payload;
    return true;
  }
}
