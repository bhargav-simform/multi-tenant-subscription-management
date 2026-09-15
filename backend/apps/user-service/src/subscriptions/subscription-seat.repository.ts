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
    assertSafeInt(delta);
    await manager
      .createQueryBuilder()
      .update(SubscriptionSeatView)
      .set({ usedSeats: () => 'used_seats + :delta' })
      .where('organizationId = :organizationId', { organizationId })
      .setParameter('delta', delta)
      .execute();
  }
}

/**
 * `delta` is always a small compile-time-controlled integer from within this
 * service (+1/-1, or a bounded count from the sweep) — never user input, and
 * bound as a query parameter (`:delta`) rather than interpolated into the SQL
 * string, so this is not a §25.1 injection concern either way. Kept as an
 * explicit assertion anyway: a non-integer here means a caller-side bug
 * (e.g. passing a count that came from something other than `.length`),
 * and failing loudly beats silently corrupting `used_seats`.
 */
function assertSafeInt(value: number): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`adjustUsedSeats delta must be an integer, got ${value}`);
  }
}
