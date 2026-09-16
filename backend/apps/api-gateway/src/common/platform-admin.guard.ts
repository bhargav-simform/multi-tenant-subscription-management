import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Role } from '@app/common';
import type { JwtAccessPayload } from '@app/auth';

/**
 * §10.2 "Coarse authorisation": role-level route gates only — "is this a Platform
 * Admin route?" Nothing finer. This guard reads one claim off the verified JWT and
 * makes a yes/no decision that needs no domain concept whatsoever, which is the
 * §10.3 test for whether logic may live in the gateway at all.
 *
 * It is deliberately NOT a CASL check. CASL stays downstream (§12.4) because an
 * ability check needs the SUBJECT in hand — the organisation row, the resource row
 * — and the gateway has none and must never load one. tenant-service enforces the
 * same rule properly against the loaded subject; this is defence in depth that
 * saves a downstream hop, not the enforcement.
 *
 * 403, not 404 (§25.2): this is a role gate, not an existence lookup. Nothing has
 * been looked up, so nothing about which organisations exist is disclosed by the
 * refusal — the caller learns only that their own role is insufficient, which they
 * already know from their own token. The 404-for-cross-tenant rule (§13, H1) is a
 * different situation entirely and lives downstream, where a row either is or is
 * not visible under RLS.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as JwtAccessPayload | undefined;

    if (!user?.roles?.includes(Role.PLATFORM_ADMIN)) {
      throw new ForbiddenException('This route is restricted to platform administrators');
    }

    return true;
  }
}
