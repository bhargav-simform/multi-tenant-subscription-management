/**
 * Every Kafka message uses this envelope (§17.7). organizationId doubles as the
 * partition key (§17.2) — a tenant's events stay ordered on one partition.
 * correlationId propagates from the originating HTTP request so a trace spans
 * gateway → service → consumer → audit record (§26.2).
 */
export interface EventEnvelope<TPayload = unknown> {
  eventId: string; // uuid — consumer idempotency key (§17.6)
  eventType: string;
  eventVersion: number;
  organizationId: string | null; // null only for platform-scoped security events
  correlationId: string;
  causationId?: string;
  actorUserId: string | null;
  occurredAt: string; // ISO 8601
  payload: TPayload;
}
