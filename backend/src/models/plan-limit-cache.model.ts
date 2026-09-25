import type { PlanLimitCache as PrismaPlanLimitCache } from '../generated/prisma/client';
import { ServiceUnavailableException } from '../lib/http-errors';
import type { Tx } from '../lib/tenant-db';

/**
 * One row per organisation. `usedStorageBytes` is the authoritative storage counter,
 * changed only inside a transaction that has locked this row; `maxStorageBytes` is
 * written only by the plan-limit-sync handler.
 */
export interface PlanLimitCache {
  organizationId: string;
  maxStorageBytes: number;
  usedStorageBytes: number;
  updatedAt: Date;
}

export interface StorageSnapshot {
  usedStorageBytes: number;
  maxStorageBytes: number;
}

function toPlanLimitCache(row: PrismaPlanLimitCache): PlanLimitCache {
  return {
    organizationId: row.organizationId,
    maxStorageBytes: Number(row.maxStorageBytes),
    usedStorageBytes: Number(row.usedStorageBytes),
    updatedAt: row.updatedAt,
  };
}

/**
 * SELECT ... FOR UPDATE — always the first lock in a storage-changing transaction.
 * A missing row means the SubscriptionAssigned event has not been applied yet: fail
 * closed with a retryable 503, never a permissive default.
 */
export async function lockForUpdate(db: Tx, organizationId: string): Promise<StorageSnapshot> {
  const rows = await db.$queryRaw<{ used_storage_bytes: bigint; max_storage_bytes: bigint }[]>`
    SELECT used_storage_bytes, max_storage_bytes
    FROM plan_limit_cache
    WHERE organization_id = ${organizationId}::uuid
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    throw new ServiceUnavailableException(
      "Your plan's storage limit is not available yet — this organisation's subscription " +
        'details are still being synchronised. Please retry in a few seconds.',
    );
  }
  return {
    usedStorageBytes: Number(row.used_storage_bytes),
    maxStorageBytes: Number(row.max_storage_bytes),
  };
}

export async function findByOrganizationId(
  db: Tx,
  organizationId: string,
): Promise<PlanLimitCache | null> {
  const row = await db.planLimitCache.findUnique({ where: { organizationId } });
  return row ? toPlanLimitCache(row) : null;
}

/**
 * Sets the ceiling, preserving used_storage_bytes on conflict (a plan change moves
 * the ceiling, never the usage). The ceiling is clamped to at least current usage so
 * ck_plan_limit_storage can never reject a lagging downgrade.
 */
export async function upsert(
  db: Tx,
  organizationId: string,
  maxStorageBytes: number,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO plan_limit_cache (organization_id, max_storage_bytes, used_storage_bytes, updated_at)
    VALUES (${organizationId}::uuid, ${maxStorageBytes}::bigint, 0, now())
    ON CONFLICT (organization_id) DO UPDATE
      SET max_storage_bytes = GREATEST(EXCLUDED.max_storage_bytes, plan_limit_cache.used_storage_bytes),
          updated_at        = now()
  `;
}

/** Must run in the transaction that locked the row; the CHECK constraints backstop it. */
export async function adjustUsedStorageBytes(
  db: Tx,
  organizationId: string,
  delta: number,
): Promise<void> {
  if (!Number.isInteger(delta)) {
    throw new TypeError(`adjustUsedStorageBytes delta must be an integer, got ${delta}`);
  }
  await db.$executeRaw`
    UPDATE plan_limit_cache
    SET used_storage_bytes = used_storage_bytes + ${delta}::bigint, updated_at = now()
    WHERE organization_id = ${organizationId}::uuid
  `;
}
