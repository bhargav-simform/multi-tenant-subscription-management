/** Counters only — no shape of this response can carry organisation content. */
export interface UsageAggregateResponse {
  organizationId: string;
  planCode: string;
  usedSeats: number;
  maxSeats: number;
  usedStorageBytes: number;
  maxStorageBytes: number;
}

export interface UsageAggregateRow {
  organization_id: string;
  plan_code: string;
  used_seats: number;
  max_seats: number;
  used_storage_bytes: bigint;
  max_storage_bytes: bigint;
}

export function toUsageAggregateResponse(row: UsageAggregateRow): UsageAggregateResponse {
  return {
    organizationId: row.organization_id,
    planCode: row.plan_code,
    usedSeats: row.used_seats,
    maxSeats: row.max_seats,
    usedStorageBytes: Number(row.used_storage_bytes),
    maxStorageBytes: Number(row.max_storage_bytes),
  };
}
