import { runGlobal } from '../lib/tenant-db';
import {
  toUsageAggregateResponse,
  type UsageAggregateResponse,
  type UsageAggregateRow,
} from '../views/usage.view';

/**
 * Platform-admin aggregates — the one legitimate cross-tenant set read. It must go
 * through the SECURITY DEFINER function: an ordinary unscoped query on the FORCE-RLS
 * subscriptions table returns zero rows, not all of them.
 */
export async function getAggregates(organizationId?: string): Promise<UsageAggregateResponse[]> {
  return runGlobal(async (tx) => {
    const rows = await tx.$queryRaw<UsageAggregateRow[]>`
      SELECT * FROM get_usage_aggregates(${organizationId ?? null}::uuid)
    `;
    return rows.map(toUsageAggregateResponse);
  });
}
