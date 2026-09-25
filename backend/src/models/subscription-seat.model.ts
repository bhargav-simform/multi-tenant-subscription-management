import { InternalServerErrorException } from '../lib/http-errors';
import type { Tx } from '../lib/tenant-db';

/**
 * The users side's narrow view of the subscriptions table: only the seat columns,
 * only inside the seat-changing transactions (invite, accept, revoke, remove,
 * sweep). The billing side lives in subscription.model.ts.
 */
export interface SeatSnapshot {
  usedSeats: number;
  maxSeatsSnapshot: number;
}

/**
 * SELECT ... FOR UPDATE on the org's subscription row. Must be the first lock a
 * seat-changing transaction takes (consistent lock ordering). A missing row means
 * onboarding is broken — a 500, not a 404.
 */
export async function lockForUpdate(db: Tx, organizationId: string): Promise<SeatSnapshot> {
  const rows = await db.$queryRaw<SeatSnapshot[]>`
    SELECT used_seats AS "usedSeats", max_seats_snapshot AS "maxSeatsSnapshot"
    FROM subscriptions
    WHERE organization_id = ${organizationId}::uuid
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    throw new InternalServerErrorException(
      `No subscription row for organization ${organizationId} — onboarding invariant violated`,
    );
  }
  return { usedSeats: Number(row.usedSeats), maxSeatsSnapshot: Number(row.maxSeatsSnapshot) };
}

/**
 * Applies a delta to used_seats in the transaction that locked the row. Raw SQL so
 * updated_at is left alone, as before.
 */
export async function adjustUsedSeats(
  db: Tx,
  organizationId: string,
  delta: number,
): Promise<void> {
  if (!Number.isInteger(delta)) {
    throw new TypeError(`adjustUsedSeats delta must be an integer, got ${delta}`);
  }
  await db.$executeRaw`
    UPDATE subscriptions SET used_seats = used_seats + ${delta}::int
    WHERE organization_id = ${organizationId}::uuid
  `;
}

/** Every subscription's org id. Under RLS an unscoped transaction sees none. */
export async function listOrganizationIds(db: Tx): Promise<string[]> {
  const rows = await db.subscription.findMany({ select: { organizationId: true } });
  return rows.map((r) => r.organizationId);
}
