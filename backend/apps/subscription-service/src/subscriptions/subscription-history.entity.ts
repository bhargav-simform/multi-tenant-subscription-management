import { Entity, Column, CreateDateColumn } from 'typeorm';
import { TenantBaseEntity } from '@app/database';

/**
 * §8.5, §14.3: RLS-protected audit trail of plan changes. Fully owned by
 * subscription-service — no cross-migration dependency, unlike `subscriptions`.
 */
@Entity('subscription_history')
export class SubscriptionHistory extends TenantBaseEntity {
  @Column({ name: 'from_plan_id', type: 'uuid', nullable: true })
  fromPlanId!: string | null;

  @Column({ name: 'to_plan_id', type: 'uuid' })
  toPlanId!: string;

  @Column({ name: 'changed_by', type: 'uuid' })
  changedBy!: string;

  @CreateDateColumn({ name: 'changed_at', type: 'timestamptz' })
  changedAt!: Date;
}
