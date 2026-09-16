import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { TenantAwareDataSource } from '@app/database';
import type { ConsumedEventStore } from '@app/kafka';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * §17.6: this service's own consumed_events table, via runGlobal() (§13.7
 * row 4 — idempotency is a per-consumer, tenant-agnostic concern, and the
 * table carries no organization_id to scope by, so it is not RLS-protected and
 * runGlobal() is the correct, auditable exception rather than a bypass).
 * Unqualified table name: audit_db's tables live in the default `public` schema
 * (§14.1), unlike user-service's `users.` and subscription-service's `subs.`
 * copies.
 *
 * Identical to resource-service's implementation, deliberately — five
 * consumers share this one store, which is safe because `event_id` is a
 * globally unique uuid minted per event and no event reaches two of this
 * service's consumers (each subscribes to exactly one topic).
 */
@Injectable()
export class PostgresConsumedEventStore implements ConsumedEventStore {
  constructor(private readonly tenantDataSource: TenantAwareDataSource) {}

  async wasConsumed(eventId: string): Promise<boolean> {
    return this.tenantDataSource.runGlobal(async (manager) => {
      const rows = await manager.query<{ event_id: string }[]>(
        `SELECT event_id FROM "consumed_events" WHERE event_id = $1`,
        [eventId],
      );
      return rows.length > 0;
    });
  }

  async markConsumed(eventId: string): Promise<void> {
    await this.tenantDataSource.runGlobal(async (manager) => {
      try {
        await manager.query(`INSERT INTO "consumed_events" (event_id) VALUES ($1)`, [eventId]);
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
