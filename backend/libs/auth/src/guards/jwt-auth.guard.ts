import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Registered as a global APP_GUARD in api-gateway ONLY (§11.5). Routes are
 * authenticated by default; @Public() is required to opt out. Four business
 * routes carry it in the whole system: /onboarding/signup, /auth/login,
 * /auth/refresh (a valid ACCESS token is exactly what this route can't
 * require — it exists because the caller's expired), and
 * /invitations/:token/accept. (/health and /health/ready are exempted
 * separately, on §26.4's grounds, not this decorator.)
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
