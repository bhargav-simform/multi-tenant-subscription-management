import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { TenantContextStore } from '../store/tenant-context.store';

/**
 * Layer-2 transport (§13.4). Runs after InternalContextGuard has verified and
 * attached the payload to the request; opens the AsyncLocalStorage scope for the
 * rest of the request lifecycle so every downstream layer — services, TypeORM
 * subscribers, the logger — can read tenant context with no parameter threading.
 *
 * Registered globally in each service's AppModule via MiddlewareConsumer, applied
 * to all routes. Public routes have no tenantContext attached (the guard skipped
 * verification for them), so this middleware simply passes through — those routes
 * establish scope explicitly inside their own handler if they need to (e.g. the
 * onboarding saga scopes itself once the organization exists).
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly store: TenantContextStore) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const payload = (
      req as Request & { tenantContext?: Parameters<TenantContextStore['run']>[0] }
    ).tenantContext;

    if (!payload) {
      next();
      return;
    }

    this.store.run(payload, next);
  }
}
