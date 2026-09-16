import { Entity, Column } from 'typeorm';
import { bigintTransformer } from '@app/database';

/**
 * §8.6, §19.6: the row every storage-limit transaction locks FOR UPDATE
 * first. Deliberately NOT extending TenantBaseEntity: this is a read model
 * keyed by organization_id, not audit-columned tenant content — there is no
 * separate `id`, no `created_at`, and no soft delete. `organization_id` IS the
 * primary key, exactly one row per organisation.
 *
 * It is still a tenant table: RLS is enabled AND forced on it in the same
 * migration that creates it (§13.5, §13.7 row 3), and it is registered in
 * TENANT_TABLES (§13.8). The policy predicate reads organization_id, which
 * here is the PK rather than an ordinary column — RLS does not care which.
 *
 * COUNTER-BASED, NOT SUM-BASED (the central design decision in this file).
 * `usedStorageBytes` is the AUTHORITATIVE running total, adjusted inside the
 * same locked transaction as every resource insert and delete — mirroring
 * exactly how subscription-service denormalises `used_seats`/
 * `used_storage_bytes` onto the subscription row rather than recomputing per
 * request. Two reasons this is right, both from §19.4:
 *   1. A `CHECK (used_storage_bytes <= max_storage_bytes)` can only guard a
 *      stored column. If enforcement read `SUM(resources.size_bytes)` while
 *      the CHECK constrained a different column, the constraint would be
 *      guarding a quantity the limit is not defined on — §19.4's exact
 *      warning. Here the enforced quantity and the constrained quantity are
 *      ONE column.
 *   2. `SUM()` over every resource row on every write does not scale, and the
 *      brief explicitly forbids "load everything into memory" aggregates.
 * `sumSizeBytesForOrg` exists on the repository for reconciliation and for
 * the drift-detection story, NEVER on the enforcement hot path (§19.4).
 */
@Entity('plan_limit_cache')
export class PlanLimitCache {
  @Column({ name: 'organization_id', type: 'uuid', primary: true })
  organizationId!: string;

  /**
   * Refreshed from subscription-service's SubscriptionChanged /
   * SubscriptionAssigned events (§8.6 "Consumes"). Never written by a request
   * path — only by the consumer.
   */
  @Column({
    name: 'max_storage_bytes',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  maxStorageBytes!: number;

  /**
   * §19.4's shape applied to storage: the authoritative counter, written ONLY
   * inside a transaction that has already locked this row FOR UPDATE. The
   * consumer that refreshes maxStorageBytes must NEVER reset this to 0 — a
   * plan change alters the ceiling, not the usage.
   */
  @Column({
    name: 'used_storage_bytes',
    type: 'bigint',
    default: 0,
    transformer: bigintTransformer,
  })
  usedStorageBytes!: number;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
