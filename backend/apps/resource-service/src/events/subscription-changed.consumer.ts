import { Inject, Injectable } from '@nestjs/common';
import {
  BaseKafkaConsumer,
  CONSUMED_EVENT_STORE,
  KAFKA_CLIENT,
  type ConsumedEventStore,
  type KafkaModuleOptions,
} from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS, type EventEnvelope, type KafkaTopic } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import { TenantAwareDataSource } from '@app/database';
import {
  PLAN_LIMIT_CACHE_REPOSITORY,
  type IPlanLimitCacheRepository,
} from '../resources/plan-limit-cache.repository.interface';

/**
 * The payload shape subscription-service publishes for both
 * SubscriptionAssigned and SubscriptionChanged. `maxStorageBytes` is carried
 * IN THE EVENT rather than resolved from `toPlanId`: the producer already
 * holds the plan at publish time, and a consumer that had to call GET /plans
 * to translate an id would put a synchronous network dependency inside an
 * event handler — see the comment at subscriptions.service.ts's publish call.
 */
interface SubscriptionPlanPayload {
  maxStorageBytes?: number;
}

const PLAN_LIMIT_EVENTS: string[] = [
  EVENT_TYPES.SUBSCRIPTION_ASSIGNED,
  EVENT_TYPES.SUBSCRIPTION_CHANGED,
];

/**
 * §8.6 "Consumes": SubscriptionChanged (and SubscriptionAssigned, which is
 * what first populates the row for a newly-onboarded organisation) ->
 * refresh plan_limit_cache.max_storage_bytes.
 *
 * §13.4 "across Kafka": BaseKafkaConsumer opens the ALS tenant scope from the
 * envelope BEFORE handle() runs, so this handler never sees an unscoped
 * payload and never calls als.run() itself. §17.6: idempotent by construction
 * via the consumed_events dedupe in the base class — and idempotent on its
 * own merits anyway, since the upsert is a set-to-absolute-value, not a delta.
 *
 * THE INVARIANT THIS CONSUMER MUST NOT BREAK: it writes max_storage_bytes
 * ONLY. `used_storage_bytes` is the authoritative counter owned by the
 * request-path transactions (§19.6) and is preserved across the upsert — a
 * plan change moves the ceiling, never the usage. Resetting it here would
 * silently free every byte an organisation had used.
 */
@Injectable()
export class SubscriptionChangedConsumer extends BaseKafkaConsumer {
  protected readonly topic: KafkaTopic = KAFKA_TOPICS.SUBSCRIPTION;

  constructor(
    @Inject(KAFKA_CLIENT) options: KafkaModuleOptions,
    tenantContext: TenantContextStore,
    @Inject(CONSUMED_EVENT_STORE) consumedEvents: ConsumedEventStore,
    private readonly tenantDataSource: TenantAwareDataSource,
    @Inject(PLAN_LIMIT_CACHE_REPOSITORY)
    private readonly planLimits: IPlanLimitCacheRepository,
  ) {
    super(options, tenantContext, consumedEvents);
  }

  protected async handle(envelope: EventEnvelope): Promise<void> {
    if (!PLAN_LIMIT_EVENTS.includes(envelope.eventType)) return;
    if (!envelope.organizationId) return;

    const payload = envelope.payload as SubscriptionPlanPayload;
    // An event with no ceiling in it cannot be acted on. Returning (rather
    // than defaulting to something permissive) leaves the previous, correct
    // ceiling in place; writing a guessed one would be worse than not
    // updating at all.
    if (typeof payload.maxStorageBytes !== 'number') {
      this.logger.warn(
        `${envelope.eventType} ${envelope.eventId} carried no maxStorageBytes — ` +
          `plan_limit_cache not updated for organization ${envelope.organizationId}`,
      );
      return;
    }

    const organizationId = envelope.organizationId;
    const maxStorageBytes = payload.maxStorageBytes;

    await this.tenantDataSource.transactionForOrganization(organizationId, (manager) =>
      this.planLimits.upsert(organizationId, maxStorageBytes, manager),
    );
  }
}
