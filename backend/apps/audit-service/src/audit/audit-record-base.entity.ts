import { Column, CreateDateColumn, PrimaryGeneratedColumn } from 'typeorm';
import type { AuditSeverity } from './audit-severity.enum';

/**
 * The column set shared by `audit_events` and `security_events` (§8.7:
 * "same shape, narrowed to cross-tenant attempts and auth failures").
 *
 * DELIBERATELY NOT `TenantBaseEntity`, and this is the load-bearing decision
 * in this file — two independent reasons, either of which alone would be
 * enough:
 *
 *   1. `TenantBaseEntity` carries `@DeleteDateColumn deletedAt`. These tables
 *      are APPEND-ONLY (§8.7: "no UPDATE or DELETE is granted to the
 *      service's database role"). A soft-delete column is a promise that a row
 *      can be retracted; nothing here can retract one, and the migration's
 *      GRANT physically forbids it. Carrying the column would make TypeORM's
 *      repository API emit `deleted_at IS NULL` predicates and offer a
 *      `softDelete()` that would fail at the grant level at runtime — a
 *      compile-time fiction of exactly the kind §15.1's bigint note warns about.
 *      `updatedAt` is absent for the same reason: an audit row is never updated.
 *
 *   2. `TenantBaseEntity.organizationId` is `uuid NOT NULL`. Here it is
 *      NULLABLE, because a platform-level security event has no organisation —
 *      a failed login for an unknown email happens before any org context
 *      exists at all (see auth-service's `publishAuthFailure`, which passes
 *      `organizationId: null` on exactly that path).
 *
 * These are nonetheless TENANT tables — they carry `organization_id`, they are
 * listed in `TENANT_TABLES`, and they get the full ENABLE + FORCE RLS
 * treatment in the migration that creates them. Not extending
 * `TenantBaseEntity` changes the column set, never the isolation posture.
 * The RLS POLICY on them does differ from `enableTenantRls()`'s standard
 * shape, and only because of the nullability in point 2 — see the migration,
 * which documents the empirical verification behind the difference.
 */
export abstract class AuditRecordBaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * §17.6, §8.7: the idempotency key — `EventEnvelope.eventId`, carried
   * through unchanged. UNIQUE in the database. `consumed_events` already
   * dedupes at the BaseKafkaConsumer level, but that store and this column are
   * written in two separate transactions (the store's `markConsumed` runs
   * after `handle()` commits), so a crash in between would replay the event
   * and attempt a second insert here. This constraint is what makes that
   * replay a no-op rather than a duplicate audit record.
   */
  @Column({ name: 'event_id', type: 'uuid', unique: true })
  eventId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType!: string;

  /** NULLABLE — see the class doc. Null means a platform-level event. */
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId!: string | null;

  @Column({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId!: string | null;

  /** §26.2: propagated from the originating HTTP request — trace reconstruction. */
  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId!: string;

  @Column({ name: 'severity', type: 'varchar', length: 16 })
  severity!: AuditSeverity;

  /**
   * The event's own payload, verbatim. For `audit_events` this may contain
   * organisation CONTENT (a resource name in a `ResourceCreated` payload), which
   * is why a platform admin's `GET /audit` never returns this column — see
   * AuditService's metadata projection (§8.7's "Platform Admin: metadata-level
   * events only").
   */
  @Column({ name: 'payload', type: 'jsonb' })
  payload!: Record<string, unknown>;

  /** The time the EVENT occurred (envelope.occurredAt), not the time it was ingested. */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  /** The time this row was written. Differs from occurredAt by the consumer lag. */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
