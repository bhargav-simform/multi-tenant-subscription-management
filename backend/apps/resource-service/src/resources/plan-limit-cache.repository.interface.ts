import type { EntityManager } from 'typeorm';
import type { PlanLimitCache } from './plan-limit-cache.entity';

export const PLAN_LIMIT_CACHE_REPOSITORY = Symbol('PLAN_LIMIT_CACHE_REPOSITORY');

export interface StorageSnapshot {
  usedStorageBytes: number;
  maxStorageBytes: number;
}

/**
 * §19.6: the ONLY interface through which this service touches
 * plan_limit_cache. Every method requires an EntityManager from an
 * already-open transaction — every legitimate use of this table is either the
 * storage-limit transaction itself or the consumer that refreshes the
 * ceiling, and both are transactional by definition.
 */
export interface IPlanLimitCacheRepository {
  /**
   * §19.2/§19.6: SELECT ... FOR UPDATE. MUST be the FIRST lock taken in any
   * storage-changing transaction (consistent lock ordering — §19.7
   * "deadlock"). Throws ServiceUnavailableException if no row exists yet for
   * the organisation; see the implementation for why that, and not a
   * permissive default.
   */
  lockForUpdate(organizationId: string, manager: EntityManager): Promise<StorageSnapshot>;

  findByOrganizationId(
    organizationId: string,
    manager: EntityManager,
  ): Promise<PlanLimitCache | null>;

  /**
   * Consumer-only (§8.6 "Consumes"). Sets max_storage_bytes, PRESERVING
   * used_storage_bytes on conflict — a plan change alters the ceiling, never
   * the usage.
   */
  upsert(organizationId: string, maxStorageBytes: number, manager: EntityManager): Promise<void>;

  /**
   * Applies a delta to used_storage_bytes within the SAME transaction that
   * locked the row. The CHECK constraints (§19.4's backstop) reject any delta
   * that would breach the ceiling or drive the counter negative.
   */
  adjustUsedStorageBytes(
    organizationId: string,
    delta: number,
    manager: EntityManager,
  ): Promise<void>;
}
