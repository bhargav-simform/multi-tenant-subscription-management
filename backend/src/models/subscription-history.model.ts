import type { Tx } from '../lib/tenant-db';

export interface RecordHistoryData {
  organizationId: string;
  fromPlanId: string | null;
  toPlanId: string;
  changedBy: string;
}

/** RLS-protected trail of plan changes. */
export async function record(db: Tx, data: RecordHistoryData): Promise<void> {
  await db.subscriptionHistory.create({ data });
}
