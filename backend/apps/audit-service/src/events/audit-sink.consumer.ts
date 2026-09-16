import { Injectable } from '@nestjs/common';
import {
  BaseKafkaConsumer,
  type ConsumedEventStore,
  type KafkaModuleOptions,
} from '@app/kafka';
import { EVENT_TYPES, type EventEnvelope } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import { TenantAwareDataSource } from '@app/database';
import type { AuditSeverity } from '../audit/audit-severity.enum';
import type {
  CreateAuditRecordData,
  IAuditRecordRepository,
} from '../audit/audit-record.repository.interface';

/**
 * Event types that represent a REJECTION and are therefore recorded at `warn`
 * rather than `info`.
 *
 * Exactly one entry, and it is worth being explicit about why: `PlanLimitExceeded`
 * is in the §17.3 catalogue but is NOT CURRENTLY PUBLISHED BY ANY SERVICE —
 * verified by grepping `EVENT_TYPES.PLAN_LIMIT_EXCEEDED` across apps/, which
 * matches only the constant's own definition. Today's rejection path in
 * user-service and resource-service raises `PlanLimitExceededException` and
 * returns 409 synchronously, with no accompanying publish. So this branch is
 * dead code at the moment, deliberately: the schema and the consumer are ready
 * for the event whenever a service adds that publish call, and §8.7 forbids
 * this service from acquiring a publisher to emit it itself. Every other event
 * type currently published is a statement of fact, not a rejection, so `info`
 * uniformly is the honest classification for them.
 */
const WARN_EVENT_TYPES: readonly string[] = [EVENT_TYPES.PLAN_LIMIT_EXCEEDED];

/**
 * §8.7: the write half of the pure sink. Shared by all five topic consumers —
 * `BaseKafkaConsumer` subscribes to exactly ONE topic
 * (`protected abstract readonly topic`), so "consume every topic" means five
 * concrete classes, and the only thing that differs between them is which topic
 * they name and which table they write to.
 *
 * §13.4 "across Kafka": BaseKafkaConsumer opens the ALS tenant scope from
 * `envelope.organizationId` BEFORE `handle()` runs, so nothing here calls
 * `als.run()` itself. §17.6: deduped by `consumed_events` in the base class,
 * and backstopped independently by `UNIQUE(event_id)` on the table itself,
 * because the marker is written in a SEPARATE transaction after this one commits
 * — a crash in between replays the event.
 */
@Injectable()
export abstract class AuditSinkConsumer<T> extends BaseKafkaConsumer {
  constructor(
    options: KafkaModuleOptions,
    tenantContext: TenantContextStore,
    consumedEvents: ConsumedEventStore,
    private readonly tenantDataSource: TenantAwareDataSource,
    private readonly records: IAuditRecordRepository<T>,
  ) {
    super(options, tenantContext, consumedEvents);
  }

  /** How this topic's events are classified. See the two subclass families below. */
  protected abstract severityFor(envelope: EventEnvelope): AuditSeverity;

  protected async handle(envelope: EventEnvelope): Promise<void> {
    const data: CreateAuditRecordData = {
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      organizationId: envelope.organizationId,
      actorUserId: envelope.actorUserId,
      correlationId: envelope.correlationId,
      severity: this.severityFor(envelope),
      // The envelope's payload verbatim. An audit sink does not interpret,
      // reshape or trim what it records — the record has to be able to answer
      // questions nobody thought to ask when it was written.
      payload: (envelope.payload ?? {}) as Record<string, unknown>,
      occurredAt: new Date(envelope.occurredAt),
    };

    /**
     * §13.4, §13.6. The transaction's scope must match the row's
     * `organization_id`, because both tables are FORCE-RLS-protected and their
     * policy's WITH CHECK has the final say:
     *
     *   organizationId present -> transactionForOrganization(): app.current_org
     *     is set, and only a row carrying that same org may be written.
     *   organizationId null    -> runGlobal(): app.current_org is left unset,
     *     and only a NULL-org row may be written.
     *
     * The null case is REAL, not defensive: auth-service publishes
     * `AuthenticationFailed` with `organizationId: null` when a login fails for
     * an email that maps to no credential, because there is no organisation to
     * attach — establishing one is what failed. Under the STANDARD
     * `enableTenantRls()` policy shape that insert would be REJECTED outright
     * (`NULL = NULL` is NULL, and WITH CHECK allows only TRUE) — confirmed
     * empirically against a real Postgres container, which is why these two
     * tables carry a nullable-org-aware policy written out in their own
     * migration. See that migration's header for the full verification.
     */
    if (envelope.organizationId === null) {
      await this.tenantDataSource.runGlobal((manager) => this.records.create(data, manager));
      return;
    }

    await this.tenantDataSource.transactionForOrganization(envelope.organizationId, (manager) =>
      this.records.create(data, manager),
    );
  }
}

/**
 * The four CONTENT topics (`organization.events`, `user.events`,
 * `subscription.events`, `resource.events`) — `audit_events`, at `info`, or
 * `warn` for a rejection. See WARN_EVENT_TYPES.
 */
@Injectable()
export abstract class ContentTopicAuditConsumer<T> extends AuditSinkConsumer<T> {
  protected severityFor(envelope: EventEnvelope): AuditSeverity {
    return WARN_EVENT_TYPES.includes(envelope.eventType) ? 'warn' : 'info';
  }
}
