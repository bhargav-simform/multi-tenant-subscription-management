/**
 * Backed by each service's own consumed_events table (§17.6, §14.3 audit_db
 * shape — but every consuming service has its own copy of this table, not just
 * audit-service, since idempotency is a per-consumer concern).
 */
export interface ConsumedEventStore {
  wasConsumed(eventId: string): Promise<boolean>;
  markConsumed(eventId: string): Promise<void>;
}
