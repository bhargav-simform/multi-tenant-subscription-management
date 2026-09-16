import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { CORRELATION_ID_HEADER, type TenantContextPayload } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import type { JwtAccessPayload } from '@app/auth';

/**
 * §11.3/§13.3/§13.4: the single point in the entire system where a client-supplied
 * JWT becomes trusted internal tenant context. Everything downstream of this line
 * reads orgId from an HMAC-signed header; nothing downstream ever sees a client token.
 *
 * WHY AN INTERCEPTOR, and not middleware or a second guard — this follows directly
 * from NestJS's request lifecycle, which runs:
 *
 *     middleware → guards → interceptors (pre) → pipes → HANDLER → interceptors (post)
 *
 *   - Middleware is too EARLY. It runs before any guard, so `req.user` does not
 *     exist yet — this is precisely why libs/tenant-context's TenantContextMiddleware
 *     cannot be reused here: it reads `req.tenantContext`, which downstream services
 *     get from InternalContextGuard verifying a SIGNED header. The gateway is the
 *     one MINTING that header, so it has no signed header to read; its source of
 *     truth is the verified JWT instead.
 *
 *   - A second APP_GUARD would run late enough (guards run in registration order, so
 *     one registered after JwtAuthGuard does see `req.user`) but is the WRONG SHAPE:
 *     AsyncLocalStorage.run(ctx, fn) keeps its scope open only for the duration of
 *     `fn`. A guard must return before the handler runs, so any scope it opened is
 *     already closed by the time the controller calls a downstream service — the
 *     context would be silently absent at exactly the moment it is needed, and
 *     InternalHttpClient would sign an ANONYMOUS context for an authenticated user.
 *     That failure is invisible to typechecking and to any test that mocks the HTTP
 *     client, which is why tenant-context.interceptor.spec.ts asserts the scope is
 *     open at CALL TIME rather than merely that run() was invoked.
 *
 *   - An interceptor is exactly right: it wraps `next.handle()`, so the ALS scope it
 *     opens stays open across the pipes, the handler body, and every downstream call
 *     the handler makes. InternalHttpClient then finds the open scope and PROPAGATES
 *     it (§9.4) with no header-building code at any call site.
 *
 * PUBLIC ROUTES (§11.5) deliberately open NO scope. With no scope open,
 * InternalHttpClient's own no-scope branch signs an ANONYMOUS context — the identical
 * header shape with userId/organizationId null — which is exactly what
 * /onboarding/signup, /auth/login and /invitations/:token/accept require. Opening an
 * explicit null-valued scope here would produce a byte-identical outgoing header via a
 * second code path, so it is not done: one mechanism, not two.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly store: TenantContextStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user as JwtAccessPayload | undefined;

    // No verified JWT: a @Public() route. Leave the scope closed — see the class
    // doc comment. Never fabricate an identity here.
    if (!user) {
      return next.handle();
    }

    const correlationId = req.header(CORRELATION_ID_HEADER) ?? '';

    const payload: TenantContextPayload = {
      // §13.3: every field below comes from the JWT auth-service signed. None of
      // them is read from a body, a query param, a path segment or a client header.
      userId: user.sub,
      organizationId: user.organizationId,
      roles: user.roles,
      correlationId,
      iat: user.iat,
      exp: user.exp,
    };

    return this.store.run(payload, () => next.handle());
  }
}
