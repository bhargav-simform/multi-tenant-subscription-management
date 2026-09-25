import type {
  Subscription as PrismaSubscription,
  SubscriptionStatus,
} from '../generated/prisma/client';
import type { Tx } from '../lib/tenant-db';

export type { SubscriptionStatus };

/**
 * One row per organisation. `usedSeats` is written only by the user-side seat lock
 * (subscription-seat.model.ts); this module adjusts the snapshots (plan change) and
 * the display-only `usedStorageBytes`.
 */
export interface Subscription {
  id: string;
  organizationId: string;
  planId: string;
  status: SubscriptionStatus;
  usedSeats: number;
  usedStorageBytes: number;
  maxSeatsSnapshot: number;
  maxStorageSnapshot: number;
  currentPeriodEnd: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSubscriptionData {
  id: string;
  organizationId: string;
  planId: string;
  maxSeatsSnapshot: number;
  maxStorageSnapshot: number;
}

export function toSubscription(row: PrismaSubscription): Subscription {
  return {
    id: row.id,
    organizationId: row.organizationId,
    planId: row.planId,
    status: row.status,
    usedSeats: row.usedSeats,
    usedStorageBytes: Number(row.usedStorageBytes),
    maxSeatsSnapshot: row.maxSeatsSnapshot,
    maxStorageSnapshot: Number(row.maxStorageSnapshot),
    currentPeriodEnd: row.currentPeriodEnd,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface RawSubscriptionRow {
  id: string;
  organization_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  used_seats: number;
  used_storage_bytes: bigint;
  max_seats_snapshot: number;
  max_storage_snapshot: bigint;
  current_period_end: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function fromRaw(row: RawSubscriptionRow): Subscription {
  return {
    id: row.id,
    organizationId: row.organization_id,
    planId: row.plan_id,
    status: row.status,
    usedSeats: row.used_seats,
    usedStorageBytes: Number(row.used_storage_bytes),
    maxSeatsSnapshot: row.max_seats_snapshot,
    maxStorageSnapshot: Number(row.max_storage_snapshot),
    currentPeriodEnd: row.current_period_end,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** FORCE RLS: `db` must come from a scoped transaction, or this finds nothing. */
export async function findByOrganizationId(
  db: Tx,
  organizationId: string,
): Promise<Subscription | null> {
  const row = await db.subscription.findUnique({ where: { organizationId } });
  return row ? toSubscription(row) : null;
}

export async function create(db: Tx, data: CreateSubscriptionData): Promise<Subscription> {
  const row = await db.subscription.create({
    data: {
      id: data.id,
      organizationId: data.organizationId,
      planId: data.planId,
      maxSeatsSnapshot: data.maxSeatsSnapshot,
      maxStorageSnapshot: BigInt(data.maxStorageSnapshot),
      usedSeats: 0,
      usedStorageBytes: 0n,
    },
  });
  return toSubscription(row);
}

/** SELECT ... FOR UPDATE — the same row every seat-changing path locks first. */
export async function lockByOrganizationId(
  db: Tx,
  organizationId: string,
): Promise<Subscription | null> {
  const rows = await db.$queryRaw<RawSubscriptionRow[]>`
    SELECT id, organization_id, plan_id, status, used_seats, used_storage_bytes,
           max_seats_snapshot, max_storage_snapshot, current_period_end, version,
           created_at, updated_at
    FROM subscriptions
    WHERE organization_id = ${organizationId}::uuid
    FOR UPDATE
  `;
  return rows[0] ? fromRaw(rows[0]) : null;
}

/** Plan id and BOTH snapshots in one statement, inside the transaction that locked the row. */
export async function applyPlanChange(
  db: Tx,
  organizationId: string,
  data: { planId: string; maxSeatsSnapshot: number; maxStorageSnapshot: number },
): Promise<void> {
  await db.subscription.updateMany({
    where: { organizationId },
    data: {
      planId: data.planId,
      maxSeatsSnapshot: data.maxSeatsSnapshot,
      maxStorageSnapshot: BigInt(data.maxStorageSnapshot),
      updatedAt: new Date(),
    },
  });
}

/** Display-only reconciliation value; never the enforcement path. */
export async function updateUsedStorageBytes(
  db: Tx,
  organizationId: string,
  value: number,
): Promise<void> {
  await db.subscription.updateMany({
    where: { organizationId },
    data: { usedStorageBytes: BigInt(value), updatedAt: new Date() },
  });
}

export async function existsForOrganization(db: Tx, organizationId: string): Promise<boolean> {
  return (await db.subscription.count({ where: { organizationId } })) > 0;
}
