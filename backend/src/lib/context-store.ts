import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantContextPayload } from '../types/tenant-context';

/**
 * Request-scoped tenant context via AsyncLocalStorage. ALS rather than passing
 * `req` around because it reaches code that never sees the request — the
 * tenant-scoped transaction helpers, the event bus, the logger.
 *
 * NEVER read tenant identity from `req` outside middlewares/authenticate.ts, which
 * is the one place that opens this scope. Every other layer calls contextStore.get().
 */
class TenantContextStore {
  private readonly als = new AsyncLocalStorage<TenantContextPayload>();

  run<T>(context: TenantContextPayload, fn: () => T): T {
    return this.als.run(context, fn);
  }

  /** The current context, or undefined outside a scoped run (bootstrap, cron job). */
  get(): TenantContextPayload | undefined {
    return this.als.getStore();
  }

  /**
   * Throws outside a scoped run. Failing loudly here turns "context missing" into a
   * 500, never into a silent cross-tenant read.
   */
  getOrThrow(): TenantContextPayload {
    const ctx = this.get();
    if (!ctx) {
      throw new Error(
        'contextStore.getOrThrow() called outside a scoped request. Every code path that ' +
          'touches tenant data must run inside the request context, or call runGlobal() explicitly.',
      );
    }
    return ctx;
  }

  /** True only for a platform admin context (organizationId === null). */
  isPlatformAdmin(): boolean {
    return this.get()?.organizationId === null;
  }
}

export const contextStore = new TenantContextStore();
