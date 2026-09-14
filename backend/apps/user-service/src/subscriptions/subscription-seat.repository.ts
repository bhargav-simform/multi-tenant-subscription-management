import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SubscriptionSeatView } from './subscription.entity';
import type {
  ISubscriptionSeatRepository,
  SeatSnapshot,
} from './subscription-seat.repository.interface';

@Injectable()
export class SubscriptionSeatRepository implements ISubscriptionSeatRepository {
  async lockForUpdate(organizationId: string, manager: EntityManager): Promise<SeatSnapshot> {
    const row = await manager
      .createQueryBuilder(SubscriptionSeatView, 'sub')
      .setLock('pessimistic_write')
      .where('sub.organizationId = :organizationId', { organizationId })
      .getOne();

    if (!row) {
      // §8.3: every organisation gets a subscription during onboarding.
      // Reaching this means onboarding is broken, not that the caller did
      // anything wrong — a 500, not a 404, is the honest response.
      throw new InternalServerErrorException(
        `No subscription row for organization ${organizationId} — onboarding invariant violated`,
      );
    }
    return { usedSeats: row.usedSeats, maxSeatsSnapshot: row.maxSeatsSnapshot };
  }

  async adjustUsedSeats(
    organizationId: string,
    delta: number,
    manager: EntityManager,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(SubscriptionSeatView)
      .set({ usedSeats: () => `used_seats + ${sqlSafeInt(delta)}` })
      .where('organizationId = :organizationId', { organizationId })
      .execute();
  }
}

/**
 * `delta` is always a small compile-time-controlled integer from within this
 * service (+1/-1) — never user input — but the value still must not be
 * interpolated as an untyped parameter into a raw SQL fragment. Validating
 * it is an integer before interpolation keeps this expression's contract
 * (§25.1's spirit: validate before it reaches the query) even though it
 * never carries request-controlled data.
 */
function sqlSafeInt(value: number): number {
  if (!Number.isInteger(value)) {
    throw new Error(`adjustUsedSeats delta must be an integer, got ${value}`);
  }
  return value;
}
