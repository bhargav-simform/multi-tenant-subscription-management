import { EVENT_TYPES, TOPICS, type EventEnvelope, type Topic } from '../../types/events';
import { subscribe } from '../../lib/events';
import * as audit from '../../services/audit.service';
import type { AuditSeverity, AuditTable } from '../../models/audit-record.model';

const WARN_EVENT_TYPES: readonly string[] = [EVENT_TYPES.PLAN_LIMIT_EXCEEDED];

/** Envelope -> audit row, verbatim. The payload is stored as published. */
export async function recordEnvelope(
  table: AuditTable,
  envelope: EventEnvelope,
  severity: AuditSeverity,
): Promise<void> {
  await audit.record(table, {
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    organizationId: envelope.organizationId,
    actorUserId: envelope.actorUserId,
    correlationId: envelope.correlationId,
    severity,
    payload: (envelope.payload ?? {}) as Record<string, unknown>,
    occurredAt: new Date(envelope.occurredAt),
  });
}

async function handleContentEvent(envelope: EventEnvelope): Promise<void> {
  const severity: AuditSeverity = WARN_EVENT_TYPES.includes(envelope.eventType) ? 'warn' : 'info';
  await recordEnvelope('audit', envelope, severity);
}

/** Every event on the four content topics lands in audit_events, unfiltered. */
const CONTENT_TOPICS: readonly Topic[] = [
  TOPICS.ORGANIZATION,
  TOPICS.USER,
  TOPICS.SUBSCRIPTION,
  TOPICS.RESOURCE,
];

export function register(): void {
  for (const topic of CONTENT_TOPICS) {
    subscribe(topic, `AuditSink(${topic})`, handleContentEvent);
  }
}
