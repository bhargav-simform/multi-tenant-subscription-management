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
    // Public routes (§11.5 — exactly three, all live in api-gateway) skip this guard.
    // A downstream service should never itself declare a route @Public(); if one
    // does, it bypasses tenant isolation and must be caught in review (§13.7 row 6).
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
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
