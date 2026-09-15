import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { TenantAwareDataSource } from '@app/database';
import type { ConsumedEventStore } from '@app/kafka';

const PG_UNIQUE_VIOLATION = '23505';

/** §17.6: this service's own consumed_events table (subs.consumed_events), via runGlobal() (§13.7 row 4). */
@Injectable()
export class PostgresConsumedEventStore implements ConsumedEventStore {
  constructor(private readonly tenantDataSource: TenantAwareDataSource) {}

  async wasConsumed(eventId: string): Promise<boolean> {
    return this.tenantDataSource.runGlobal(async (manager) => {
      const rows = await manager.query<{ event_id: string }[]>(
        `SELECT event_id FROM "subs"."consumed_events" WHERE event_id = $1`,
        [eventId],
      );
      return rows.length > 0;
    });
  }

  async markConsumed(eventId: string): Promise<void> {
    await this.tenantDataSource.runGlobal(async (manager) => {
      try {
        await manager.query(`INSERT INTO "subs"."consumed_events" (event_id) VALUES ($1)`, [
          eventId,
        ]);
      } catch (err) {
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
