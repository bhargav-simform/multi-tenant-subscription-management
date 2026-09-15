import { Entity, Column } from 'typeorm';
import { bigintTransformer } from '@app/database';

export enum SubscriptionStatus {
  ACTIVE = 'active',
  CANCELLED = 'cancelled',
}

/**
 * §14.2, §32.3 "Migration sequencing for core_db": this table was CREATED by
 * user-service's migration (minimally shaped: id, organization_id,
 * used_seats, max_seats_snapshot, plus the seat CHECK) so its concurrency
 * tests could run against a real row before this service existed.
 * subscription-service's own migration EXTENDS that same physical table via
 * ALTER TABLE, adding every column below that user-service's migration did
 * NOT create — it never drops or recreates the table (§32.3).
 *
 * organizationId is UNIQUE — one subscription per organisation (§8.5).
 * NOT extending TenantBaseEntity: this table has created_at/updated_at
 * (added by THIS service's migration) but deliberately NO deleted_at —
 * subscriptions are never soft-deleted. An organisation's subscription row
 * lives as long as the organisation does; a suspended or failed org
 * (OrganizationStatus.PROVISIONING_FAILED/SUSPENDED, §30.1) still has one.
 * TenantBaseEntity would add deleted_at unconditionally, so this entity
 * declares its own columns instead, matching exactly what exists across
 * both this service's and user-service's migrations combined.
 */
@Entity('subscriptions')
export class Subscription {
  @Column({ type: 'uuid', primary: true })
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid', unique: true })
  organizationId!: string;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId!: string;

  @Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.ACTIVE })
  status!: SubscriptionStatus;

  /** §19.4: the authoritative seat counter — user-service writes this, never a consumer here. */
  @Column({ name: 'used_seats', type: 'int', default: 0 })
  usedSeats!: number;

  @Column({ name: 'used_storage_bytes', type: 'bigint', default: 0, transformer: bigintTransformer })
  usedStorageBytes!: number;

  /** §19.4: denormalised so the CHECK constraint can reference it (a CHECK cannot span tables). */
  @Column({ name: 'max_seats_snapshot', type: 'int' })
  maxSeatsSnapshot!: number;

  @Column({ name: 'max_storage_snapshot', type: 'bigint', transformer: bigintTransformer })
  maxStorageSnapshot!: number;

  @Column({ name: 'current_period_end', type: 'timestamptz', nullable: true })
  currentPeriodEnd!: Date | null;

  /** Optimistic-concurrency column named in §14.3's schema sketch; not currently read by any query. */
  @Column({ type: 'int', default: 0 })
  version!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
