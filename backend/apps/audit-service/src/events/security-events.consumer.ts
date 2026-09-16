import { Inject, Injectable } from '@nestjs/common';
import {
  CONSUMED_EVENT_STORE,
  KAFKA_CLIENT,
  type ConsumedEventStore,
  type KafkaModuleOptions,
} from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS, type EventEnvelope, type KafkaTopic } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import { TenantAwareDataSource } from '@app/database';
import type { AuditSeverity } from '../audit/audit-severity.enum';
import type { SecurityEvent } from '../audit/security-event.entity';
import {
  SECURITY_EVENT_REPOSITORY,
  type ISecurityEventRepository,
} from '../audit/audit-record.repository.interface';
import { AuditSinkConsumer } from './audit-sink.consumer';

/**
 * The two event types on `security.events` in the §17.3 catalogue — confirmed
 * against libs/common/src/events/event-types.ts rather than assumed. Listed
 * here only so the "unexpected type on this topic" case below is detectable;
 * the row is written either way.
 */
const KNOWN_SECURITY_EVENT_TYPES: readonly string[] = [
  EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED,
  EVENT_TYPES.AUTHENTICATION_FAILED,
];

/**
 * §8.7, §13.9, §26: the fifth consumer, and the one that makes the production
 * tenant-leak detector real. Everything on `security.events` goes into
 * `security_events` at `severity: 'security'`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NO RECONCILIATION HAPPENS HERE, AND THAT IS THE DESIGN, NOT AN OMISSION
 * ────────────────────────────────────────────────────────────────────────────
 *
 * An earlier draft of §13.9 had audit-service decide whether a
 * `CrossTenantAccessAttempted` event deserved `security` severity, by checking
 * whether the attempted id was "known to exist under a different organisation".
 * That is NOT how this system works. The reconciliation happens at the SOURCE:
 * resource-service's and user-service's `reportIfCrossTenantAttempt()` each run
 * a narrow SECURITY DEFINER existence probe (`resource_exists`,
 * `users.user_exists`, both owned by the BYPASSRLS `app_rls_bypass` role — §13.6)
 * BEFORE publishing, and publish NOTHING when the id genuinely does not exist.
 *
 * So by the time an event reaches this consumer it is ALREADY a confirmed
 * cross-tenant attempt, not a raw "not found" signal. Re-deriving that here
 * would be strictly worse in three ways: audit_db holds no copy of
 * resource_db's or core_db's rows to probe, so it could not answer the question
 * at all; a sink that decides what to record can be made to decide not to; and
 * the probe's answer at ingest time is not the answer at attempt time.
 *
 * `AuthenticationFailed` needs no reconciliation by construction — a failed
 * login is the event, not evidence of one.
 *
 * Writing EVERY event on this topic at `security`, unconditionally, is therefore
 * both correct and the only defensible behaviour for a sink: the classification
 * is carried by the TOPIC, which the producer chose and this service cannot be
 * argued out of.
 */
@Injectable()
export class SecurityEventsConsumer extends AuditSinkConsumer<SecurityEvent> {
  protected readonly topic: KafkaTopic = KAFKA_TOPICS.SECURITY;

  constructor(
    @Inject(KAFKA_CLIENT) options: KafkaModuleOptions,
    tenantContext: TenantContextStore,
    @Inject(CONSUMED_EVENT_STORE) consumedEvents: ConsumedEventStore,
    tenantDataSource: TenantAwareDataSource,
    @Inject(SECURITY_EVENT_REPOSITORY) securityEvents: ISecurityEventRepository,
  ) {
    super(options, tenantContext, consumedEvents, tenantDataSource, securityEvents);
  }

  protected severityFor(envelope: EventEnvelope): AuditSeverity {
    if (!KNOWN_SECURITY_EVENT_TYPES.includes(envelope.eventType)) {
      // Logged, then recorded anyway. A security-topic event this service does
      // not recognise is the LAST thing to drop or downgrade — it is either a
      // new detection signal nobody updated this list for, or something
      // publishing to the security topic that should not be. Both are worth a
      // durable record; neither is worth a lost one.
      this.logger.warn(
        `Unrecognised event type "${envelope.eventType}" on ${KAFKA_TOPICS.SECURITY} ` +
          `(event ${envelope.eventId}) — recording at 'security' severity regardless`,
      );
    }
    return 'security';
  }
}
