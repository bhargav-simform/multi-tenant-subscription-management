import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { TenantContextPayload } from '@app/common';

/**
 * Request-scoped tenant context via AsyncLocalStorage (ARCHITECTURE.md §13.4).
 *
 * Chosen over NestJS request-scoped DI providers because ALS reaches code Nest does
 * not inject into — TypeORM subscribers, the TenantAwareDataSource wrapper, the
 * logger — which is exactly where the tenant filter must be applied (§13.4, §15.3).
 *
 * NEVER read tenant context from `req` directly anywhere outside the middleware
 * that populates this store. Every other layer calls TenantContextStore.get().
 */
@Injectable()
export class TenantContextStore {
  private readonly als = new AsyncLocalStorage<TenantContextPayload>();

  run<T>(context: TenantContextPayload, fn: () => T): T {
    return this.als.run(context, fn);
  }

  /**
   * Returns the current context, or undefined if called outside a scoped run
   * (e.g. at application bootstrap, or a bug where a guard was skipped).
   */
  get(): TenantContextPayload | undefined {
    return this.als.getStore();
  }

  /**
   * Throws if called outside a scoped run. Use this in any code path that MUST
   * have tenant context to be safe — e.g. TenantAwareDataSource, TenantRepository.
   * Failing loudly here is what turns "context missing" into "500", never a silent
   * cross-tenant read.
   */
  getOrThrow(): TenantContextPayload {
    const ctx = this.get();
    if (!ctx) {
      throw new Error(
        'TenantContextStore.getOrThrow() called outside a scoped request. ' +
          'This is a bug: every code path that touches tenant data must run inside ' +
          'TenantContextMiddleware, or explicitly call runGlobal() (§15.3).',
      );
    }
    return ctx;
  }

  /** True only for a platform admin context (organizationId === null) — §13.6. */
  isPlatformAdmin(): boolean {
    return this.get()?.organizationId === null;
  }
}
