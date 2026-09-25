import type { AuditRecord } from '../models/audit-record.model';
import type { CursorPage } from '../types/pagination';

export interface AuditEventMetadataResponse {
  id: string;
  eventId: string;
  eventType: string;
  organizationId: string | null;
  actorUserId: string | null;
  correlationId: string;
  severity: string;
  occurredAt: Date;
}

export interface AuditEventResponse extends AuditEventMetadataResponse {
  payload: Record<string, unknown>;
}

/** What a platform admin sees: who/what/when, never the payload (tenant content). */
export function toAuditMetadataResponse(row: AuditRecord): AuditEventMetadataResponse {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    organizationId: row.organizationId,
    actorUserId: row.actorUserId,
    correlationId: row.correlationId,
    severity: row.severity,
    occurredAt: row.occurredAt,
  };
}

export function toAuditResponse(row: AuditRecord): AuditEventResponse {
  return { ...toAuditMetadataResponse(row), payload: row.payload };
}

export function mapPage<T, R>(page: CursorPage<T>, map: (row: T) => R): CursorPage<R> {
  return { items: page.items.map(map), nextCursor: page.nextCursor, hasMore: page.hasMore };
}
