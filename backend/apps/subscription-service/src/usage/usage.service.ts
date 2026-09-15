import { Injectable } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import type { UsageAggregateResponseDto } from './dto/usage-aggregate-response.dto';

interface UsageAggregateRow {
  organization_id: string;
  plan_code: string;
  used_seats: number;
  max_seats: number;
  used_storage_bytes: string; // bigint comes back as string from pg
  max_storage_bytes: string;
}

/**
 * §8.5, R9: platform-admin aggregates — the one legitimate cross-tenant SET
 * read in the system. Calls `subs.get_usage_aggregates()`, a SECURITY
 * DEFINER function (§13.6) — NOT a plain query through the ORM.
 *
 * This distinction matters and was verified empirically, not assumed: with
 * RLS FORCED on subs.subscriptions, an ordinary app_user query with
 * app.current_org unset (which is what runGlobal() alone would produce)
 * returns ZERO rows for every organisation, not all rows — RLS's USING
 * predicate evaluates to NULL when the setting is unset, and NULL filters a
 * row out exactly like FALSE does. A query builder against the Subscription
 * entity here would silently return an empty array forever; this function
 * is what actually makes a cross-org read possible, and it exposes only the
 * integer/enum columns this endpoint needs.
 */
@Injectable()
export class UsageService {
  constructor(private readonly tenantDataSource: TenantAwareDataSource) {}

  async getAggregates(organizationId?: string): Promise<UsageAggregateResponseDto[]> {
    return this.tenantDataSource.runGlobal(async (manager) => {
      const rows = await manager.query<UsageAggregateRow[]>(
        `SELECT * FROM subs.get_usage_aggregates($1)`,
        [organizationId ?? null],
      );
      return rows.map(toDto);
    });
  }
}

function toDto(row: UsageAggregateRow): UsageAggregateResponseDto {
  return {
    organizationId: row.organization_id,
    planCode: row.plan_code,
    usedSeats: row.used_seats,
    maxSeats: row.max_seats,
    usedStorageBytes: Number(row.used_storage_bytes),
    maxStorageBytes: Number(row.max_storage_bytes),
  };
}
