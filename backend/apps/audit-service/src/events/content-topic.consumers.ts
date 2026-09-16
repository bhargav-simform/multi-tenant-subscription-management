import { Inject, Injectable } from '@nestjs/common';
import {
  CONSUMED_EVENT_STORE,
  KAFKA_CLIENT,
  type ConsumedEventStore,
  type KafkaModuleOptions,
} from '@app/kafka';
import { KAFKA_TOPICS, type KafkaTopic } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import { TenantAwareDataSource } from '@app/database';
import type { AuditEvent } from '../audit/audit-event.entity';
import {
  AUDIT_EVENT_REPOSITORY,
  type IAuditEventRepository,
} from '../audit/audit-record.repository.interface';
import { ContentTopicAuditConsumer } from './audit-sink.consumer';

/**
 * §8.7 "Consumes: every topic". `BaseKafkaConsumer` subscribes to exactly ONE
 * topic, so the four CONTENT topics need four concrete classes — this file —
 * and `security.events` needs a fifth, which classifies differently and writes
 * to a different table (see security-events.consumer.ts).
 *
 * All four are identical but for the topic they name. They exist as separate
 * classes rather than one parameterised provider because the topic is an
 * `abstract readonly` member of the base class, and because Nest instantiates a
 * provider per class — a single class registered four times would subscribe
 * four times from one `onModuleInit`, or, more likely, three of the four topics
 * would silently go unconsumed.
 *
 * Every one of them writes to `audit_events` at `info` (or `warn` for a
 * rejection — see WARN_EVENT_TYPES). They do NOT filter by event type: an audit
 * sink records everything on its topics, including event types added later that
 * nothing here has been taught about. A consumer that skipped unrecognised
 * events would make the audit trail silently incomplete exactly when a new
 * feature shipped, which is the worst possible time.
 */
abstract class BaseContentTopicConsumer extends ContentTopicAuditConsumer<AuditEvent> {
  constructor(
    @Inject(KAFKA_CLIENT) options: KafkaModuleOptions,
    tenantContext: TenantContextStore,
    @Inject(CONSUMED_EVENT_STORE) consumedEvents: ConsumedEventStore,
    tenantDataSource: TenantAwareDataSource,
    @Inject(AUDIT_EVENT_REPOSITORY) auditEvents: IAuditEventRepository,
  ) {
    super(options, tenantContext, consumedEvents, tenantDataSource, auditEvents);
  }
}

/** Producer: tenant-service. OrganizationCreated/Provisioned, OnboardingFailed, OrganizationSuspended. */
@Injectable()
export class OrganizationEventsConsumer extends BaseContentTopicConsumer {
  protected readonly topic: KafkaTopic = KAFKA_TOPICS.ORGANIZATION;
}

/** Producers: user-service, auth-service. The invitation/seat lifecycle (§17.3). */
@Injectable()
export class UserEventsConsumer extends BaseContentTopicConsumer {
  protected readonly topic: KafkaTopic = KAFKA_TOPICS.USER;
}

/** Producer: subscription-service. Includes PlanLimitExceeded once something publishes it. */
@Injectable()
export class SubscriptionEventsConsumer extends BaseContentTopicConsumer {
  protected readonly topic: KafkaTopic = KAFKA_TOPICS.SUBSCRIPTION;
}

/** Producer: resource-service. ResourceCreated/ResourceDeleted. */
@Injectable()
export class ResourceEventsConsumer extends BaseContentTopicConsumer {
  protected readonly topic: KafkaTopic = KAFKA_TOPICS.RESOURCE;
}
