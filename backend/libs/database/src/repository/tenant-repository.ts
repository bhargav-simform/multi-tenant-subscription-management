import { EntityManager, FindOptionsWhere, Repository } from 'typeorm';
import { TenantContextStore } from '@app/tenant-context';
import { TenantBaseEntity } from '../entities/tenant-base.entity';

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
 * Every method still runs inside a transaction opened by TenantAwareDataSource,
 * so app.current_org is always set and RLS filters the result regardless of
 * whether this class added its own predicate correctly.
 */
export abstract class TenantRepository<T extends TenantBaseEntity> {
  protected abstract get repository(): Repository<T>;

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

  async findById(id: string, manager?: EntityManager): Promise<T | null> {
    const repo = manager ? manager.getRepository<T>(this.repository.target) : this.repository;
    return repo.findOne({
      where: { id, organizationId: this.organizationId } as FindOptionsWhere<T>,
    });
  }

  async save(entity: Partial<T>, manager?: EntityManager): Promise<T> {
    const repo = manager ? manager.getRepository<T>(this.repository.target) : this.repository;
    const withTenant = { ...entity, organizationId: this.organizationId };
    return repo.save(withTenant as T);
  }
}
