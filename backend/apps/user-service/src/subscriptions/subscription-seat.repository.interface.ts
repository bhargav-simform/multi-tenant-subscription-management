import type { EntityManager } from 'typeorm';

export const SUBSCRIPTION_SEAT_REPOSITORY = Symbol('SUBSCRIPTION_SEAT_REPOSITORY');

export interface SeatSnapshot {
  usedSeats: number;
  maxSeatsSnapshot: number;
}

/**
 * §14.2, §19.4: the ONLY interface through which user-service touches
 * subs.subscriptions. Every method requires an EntityManager from an ALREADY
 * OPEN transaction — there is no method that reads or writes this table
 * outside a transaction, because every legitimate use of this table is one
 * of the six seat-changing paths enumerated in §19.4, and all six are
 * transactional by definition.
 */
export interface ISubscriptionSeatRepository {
  /**
   * §19.2: SELECT ... FOR UPDATE. Must be the FIRST lock taken in any
   * seat-changing transaction (§19.7 "deadlock" — consistent lock ordering).
   * Throws if no subscription row exists for the org (a data integrity bug,
   * since every organisation gets one during onboarding — §8.3).
   */
  lockForUpdate(organizationId: string, manager: EntityManager): Promise<SeatSnapshot>;

  /** Applies a delta to used_seats within the SAME transaction that locked it. */
  adjustUsedSeats(organizationId: string, delta: number, manager: EntityManager): Promise<void>;
}
