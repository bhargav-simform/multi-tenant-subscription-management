import type { EntityManager } from 'typeorm';
import type { CursorPage, CursorQuery } from '@app/common';
import type { AuditSeverity } from './audit-severity.enum';
import type { AuditEvent } from './audit-event.entity';
import type { SecurityEvent } from './security-event.entity';

export const AUDIT_EVENT_REPOSITORY = Symbol('AUDIT_EVENT_REPOSITORY');
export const SECURITY_EVENT_REPOSITORY = Symbol('SECURITY_EVENT_REPOSITORY');

/**
 * What a consumer hands over after classifying an envelope. Every field comes
 * straight off the `EventEnvelope` (§17.7) except `severity`, which is the
 * classification itself — see AuditSeverity.
 *
 * `organizationId` is carried EXPLICITLY rather than taken from ambient tenant
 * context, and this is deliberate: it is null for a platform-level event, and
 * `TenantRepository`'s inherited `organizationId` getter THROWS on a null
 * context by design (§13.6). A consumer is not an HTTP request; the envelope is
 * the authority for which organisation an event belongs to (§13.4).
 */
export interface CreateAuditRecordData {
  eventId: string;
  eventType: string;
  organizationId: string | null;
  actorUserId: string | null;
  correlationId: string;
  severity: AuditSeverity;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * §20.2: the domain declares this interface; the TypeORM implementations are
 * bound to the two tokens above in audit.module.ts.
 *
 * Every method requires an EntityManager from an ALREADY-OPEN,
 * TenantAwareDataSource-scoped transaction (§32.4). Both tables have FORCE ROW
 * LEVEL SECURITY, so a query on a connection with no `app.current_org` set
 * returns only the PLATFORM-level (null-org) rows — never a tenant's — and a
 * write of a tenant's row is rejected outright. Requiring the manager makes a
 * missing scope a compile error rather than a silent wrong-slice result.
 *
 * There is deliberately NO update, delete, or upsert method on this interface.
 * `audit_events` and `security_events` are append-only, and the database GRANT
 * backs that independently (§8.7) — a method added here would fail at runtime
 * with an insufficient-privilege error, which is the correct outcome but a
 * worse one than never being able to write the method.
 */
export interface IAuditRecordRepository<T> {
  /** Called only by the Kafka consumers. Idempotent at the DB level via UNIQUE(event_id). */
  create(data: CreateAuditRecordData, manager: EntityManager): Promise<T>;

  /**
   * §29, §14.4: keyset pagination on `(organization_id, occurred_at DESC, id)`
   * — never OFFSET. Scoped to the caller's own organisation, in application
   * code AND by RLS underneath.
   */
  listPage(query: CursorQuery, manager: EntityManager): Promise<CursorPage<T>>;

  /**
   * §13.6: the platform-admin variant. A platform admin's context carries
   * `organizationId === null`, so there is no org to scope BY — the inherited
   * `organizationId` getter would throw. This method omits the application-level
   * predicate entirely and relies on the caller having opened the transaction
   * through `runGlobal()`.
   *
   * On its own that reads ACROSS organisations, which is exactly why the
   * SERVICE, not this method, carries the explicit platform-admin check — the
   * same reasoning tenant-service applies to `listOrganizations()` (§12.5,
   * §13.6). Do not call this from any path that has not already asserted the
   * caller is a platform admin.
   */
  listAllForPlatformAdmin(query: CursorQuery, manager: EntityManager): Promise<CursorPage<T>>;
}

export type IAuditEventRepository = IAuditRecordRepository<AuditEvent>;
export type ISecurityEventRepository = IAuditRecordRepository<SecurityEvent>;
