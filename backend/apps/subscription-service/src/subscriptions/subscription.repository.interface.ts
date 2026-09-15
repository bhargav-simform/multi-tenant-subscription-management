import type { EntityManager } from 'typeorm';
import type { Subscription } from './subscription.entity';

export const SUBSCRIPTION_REPOSITORY = Symbol('SUBSCRIPTION_REPOSITORY');

export interface CreateSubscriptionData {
  id: string;
  organizationId: string;
  planId: string;
  maxSeatsSnapshot: number;
  maxStorageSnapshot: number;
}

/**
 * §14.2: this service and user-service share the SAME PHYSICAL ROW in
 * subs.subscriptions. `used_seats` is user-service's exclusively (§19.4 —
 * "never written by a consumer", and by extension never written by
 * subscription-service either, since the reasoning is identical: it is the
 * authoritative enforcement quantity, maintained only inside the locked
 * seat-changing transaction). `max_seats_snapshot` IS writable here, but
 * ONLY via the downgrade path (§19.10), which locks the row first and
 * validates usage against the target plan before changing it — never a
 * plain UPDATE from outside that transaction.
 */
export interface ISubscriptionRepository {
  /** RLS-scoped (FORCE ROW LEVEL SECURITY) — manager MUST come from a TenantAwareDataSource-scoped transaction. */
  findByOrganizationId(organizationId: string, manager: EntityManager): Promise<Subscription | null>;
  create(data: CreateSubscriptionData, manager: EntityManager): Promise<Subscription>;
  /** §19.10: locked FIRST, before any other write, same as every §19.4 seat-changing path. */
  lockByOrganizationId(organizationId: string, manager: EntityManager): Promise<Subscription | null>;
  /**
   * §19.10: the downgrade write. Updates plan_id + BOTH snapshot columns in
   * the SAME transaction that locked and validated the row — the CHECK
   * constraints must never see a transient violation.
   */
  applyPlanChange(
    organizationId: string,
    data: { planId: string; maxSeatsSnapshot: number; maxStorageSnapshot: number },
    manager: EntityManager,
  ): Promise<void>;
  /** §8.5 "reconcile" — display-only, never the enforcement path (§19.4). */
  updateUsedStorageBytes(organizationId: string, value: number, manager: EntityManager): Promise<void>;
}
