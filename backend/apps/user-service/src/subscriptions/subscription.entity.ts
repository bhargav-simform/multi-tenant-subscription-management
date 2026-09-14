import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

/**
 * §14.2: user-service's role has SELECT/UPDATE on subs.subscriptions and
 * NOTHING ELSE in the subs schema — this entity maps ONLY the columns §19's
 * seat-lock transactions need. It does NOT extend TenantBaseEntity (no RLS —
 * subscriptions IS a tenant table with RLS, §14.3, but this entity is a
 * narrow view into a table user-service does not fully own; the full entity
 * with all columns and the RLS-aware base class belongs to
 * subscription-service when it is built — see ARCHITECTURE.md §32.3
 * "Migration sequencing for core_db").
 *
 * THIS ENTITY MUST NEVER BE USED FOR AN ORDINARY QUERY. Its only legitimate
 * use is inside the six seat-changing transactions enumerated in §19.4 —
 * anything else is the exact cross-schema violation §14.2 forbids.
 */
@Entity({ name: 'subscriptions', schema: 'subs' })
export class SubscriptionSeatView {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'organization_id', type: 'uuid', unique: true })
  organizationId!: string;

  @Column({ name: 'used_seats', type: 'int' })
  usedSeats!: number;

  @Column({ name: 'max_seats_snapshot', type: 'int' })
  maxSeatsSnapshot!: number;
}
