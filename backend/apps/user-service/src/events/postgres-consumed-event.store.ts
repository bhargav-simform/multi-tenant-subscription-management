import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { TenantAwareDataSource } from '@app/database';
import type { ConsumedEventStore } from '@app/kafka';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * §17.6: this service's own consumed_events table (users.consumed_events —
 * a GLOBAL table, no tenant scope, §13.8). Raw SQL, not an entity — this
 * table exists purely for dedupe bookkeeping and has no domain meaning
 * worth a repository interface of its own.
 *
 * Goes through TenantAwareDataSource.runGlobal(), never a raw DataSource
 * connection (§13.7 row 4, §15.3) — this table is genuinely tenant-agnostic
 * (no organization_id column at all), so runGlobal() is the correct,
 * auditable, named exception, not a silent bypass reviewers have to
 * separately judge as harmless for this one call site.
 */
@Injectable()
export class PostgresConsumedEventStore implements ConsumedEventStore {
  constructor(private readonly tenantDataSource: TenantAwareDataSource) {}

  async wasConsumed(eventId: string): Promise<boolean> {
    return this.tenantDataSource.runGlobal(async (manager) => {
      const rows = await manager.query<{ event_id: string }[]>(
        `SELECT event_id FROM "users"."consumed_events" WHERE event_id = $1`,
        [eventId],
      );
      return rows.length > 0;
    });
  }

  async markConsumed(eventId: string): Promise<void> {
    await this.tenantDataSource.runGlobal(async (manager) => {
      try {
        await manager.query(`INSERT INTO "users"."consumed_events" (event_id) VALUES ($1)`, [
          eventId,
        ]);
      } catch (err) {
        // A duplicate insert (§17.6) means another process already marked
        // this event consumed — not an error, the dedupe working as intended.
        if (
          err instanceof QueryFailedError &&
          (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
        ) {
          return;
        }
        throw err;
      }
    });
  }
}
