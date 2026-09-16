import { EntityManager, EntityTarget, FindOptionsWhere } from 'typeorm';
import { TenantContextStore } from '@app/tenant-context';

/**
 * Defence-in-depth wrapper over TypeORM's Repository (§13.5 "second mechanism").
 *
 * THIS IS NOT THE GUARANTEE. PostgreSQL RLS is (§13.5, §13.8 T2). This class
 * exists for two reasons that matter independently of RLS:
 *   1. readable, obviously-correct application code — reviewers should not have
 *      to reason about RLS to trust a query;
 *   2. defence in depth — two independent mechanisms must both fail for a leak
 *      to occur.
 *
 * `manager` is REQUIRED on every method (§32.4) — this class used to fall back
 * to an injected, unscoped `repository` getter when no manager was passed,
 * the exact "optional manager silently hits the raw DataSource" landmine that
 * produced several real defects elsewhere in this codebase (found once a real
 * Postgres-backed integration test finally exercised those paths). This base
 * class had the identical bug in code no subclass happened to call yet —
 * removing the fallback here means every future subclass inherits the fix
 * instead of inheriting the landmine. The caller must always come from a
 * transaction opened by TenantAwareDataSource, so app.current_org is always
 * set and RLS filters the result regardless of whether this class's own
 * predicate is correct.
 */
/**
 * The minimum shape this class's own two concrete methods need: an `id` to
 * look up by and an `organization_id` to scope by. `TenantBaseEntity` satisfies
 * it — every existing subclass is unaffected — but it is deliberately NOT the
 * constraint itself, because not every tenant table's entity is shaped like
 * `TenantBaseEntity`.
 *
 * The concrete case that forced this widening (§32.4): audit-service's
 * `audit_events`/`security_events` are genuinely tenant-owned — `organization_id`,
 * `TENANT_TABLES`, ENABLE + FORCE RLS, the lot — but they are APPEND-ONLY, so
 * they carry no `updated_at`/`deleted_at`, and their `organization_id` is
 * NULLABLE because a platform-level security event (a failed login before any
 * org context exists) has no organisation. Neither difference weakens
 * isolation; both make `TenantBaseEntity` the wrong column set. The alternative
 * — letting those repositories skip `TenantRepository` entirely — would have put
 * the one pair of repositories with an unusual shape OUTSIDE the
 * defence-in-depth layer, which is exactly backwards.
 *
 * Note `organizationId` is `string | null` here, not `string`: a narrower
 * declaration would make the nullable-column case unassignable. The `organizationId`
 * GETTER below still returns a non-null `string` or throws, so no subclass gains
 * the ability to write an unscoped row through the inherited methods.
 */
export interface TenantScopedEntity {
  id: string;
  organizationId: string | null;
}

export abstract class TenantRepository<T extends TenantScopedEntity> {
  protected abstract readonly entityTarget: EntityTarget<T>;

  constructor(protected readonly tenantContext: TenantContextStore) {}

  protected get organizationId(): string {
    const ctx = this.tenantContext.getOrThrow();
    if (ctx.organizationId === null) {
      throw new Error(
        'TenantRepository used from a platform-admin context (organizationId is null). ' +
          'Platform admins must not read tenant content — this is a code path that should not exist (§13.6).',
      );
    }
    return ctx.organizationId;
  }

  async findById(id: string, manager: EntityManager): Promise<T | null> {
    return manager.getRepository(this.entityTarget).findOne({
      where: { id, organizationId: this.organizationId } as FindOptionsWhere<T>,
    });
  }

  async save(entity: Partial<T>, manager: EntityManager): Promise<T> {
    const withTenant = { ...entity, organizationId: this.organizationId };
    return manager.getRepository(this.entityTarget).save(withTenant as T);
  }
}
