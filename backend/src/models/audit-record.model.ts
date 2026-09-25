import type { Prisma } from '../generated/prisma/client';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import type { Tx } from '../lib/tenant-db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type CursorPage } from '../types/pagination';

export type AuditSeverity = 'info' | 'warn' | 'security';

/** audit_events and security_events share one shape; `kind` picks the table. */
export type AuditTable = 'audit' | 'security';

export interface AuditRecord {
  id: string;
  eventId: string;
  eventType: string;
  organizationId: string | null;
  actorUserId: string | null;
  correlationId: string;
  severity: AuditSeverity;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export type CreateAuditRecordData = Omit<AuditRecord, 'id'>;

export interface AuditPageQuery {
  cursor?: string;
  limit?: number;
  eventType?: string;
}

type Row = Omit<AuditRecord, 'severity' | 'payload'> & {
  severity: string;
  payload: Prisma.JsonValue;
};

function toRecord(row: Row): AuditRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    organizationId: row.organizationId,
    actorUserId: row.actorUserId,
    correlationId: row.correlationId,
    severity: row.severity as AuditSeverity,
    payload: row.payload as Record<string, unknown>,
    occurredAt: row.occurredAt,
  };
}

/**
 * Append-only: there is deliberately no update or delete here, and app_user has no
 * UPDATE/DELETE grant on either table, so none could be added that would work.
 */
export async function create(
  db: Tx,
  table: AuditTable,
  data: CreateAuditRecordData,
): Promise<AuditRecord> {
  const input = { ...data, payload: data.payload as Prisma.InputJsonObject };
  const row =
    table === 'audit'
      ? await db.auditEvent.create({ data: input })
      : await db.securityEvent.create({ data: input });
  return toRecord(row);
}

/**
 * Keyset page, newest first. `organizationId` null means no application-level org
 * filter (the platform-admin path) — RLS still applies to whatever scope the
 * transaction has, which for an unscoped transaction means NULL-org rows only.
 */
export async function listPage(
  db: Tx,
  table: AuditTable,
  query: AuditPageQuery,
  organizationId: string | null,
): Promise<CursorPage<AuditRecord>> {
  const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const and: Prisma.AuditEventWhereInput[] = [];
  if (organizationId !== null) and.push({ organizationId });
  if (query.eventType) and.push({ eventType: query.eventType });
  if (query.cursor) {
    // (occurred_at, id) < (cursorOccurredAt, cursorId)
    const [cursorOccurredAt, cursorId] = decodeCursor(query.cursor);
    const at = new Date(cursorOccurredAt);
    and.push({ OR: [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: cursorId } }] });
  }

  // Both tables have identical columns, so the same filter fits either.
  const where: Prisma.AuditEventWhereInput = { AND: and };
  const orderBy: Prisma.AuditEventOrderByWithRelationInput[] = [
    { occurredAt: 'desc' },
    { id: 'desc' },
  ];
  const rows =
    table === 'audit'
      ? await db.auditEvent.findMany({ where, orderBy, take: limit + 1 })
      : await db.securityEvent.findMany({
          where: where as Prisma.SecurityEventWhereInput,
          orderBy: orderBy,
          take: limit + 1,
        });

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(toRecord);
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.occurredAt.toISOString(), last.id) : null,
  };
}
