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
  SUBSCRIPTION_REPOSITORY,
  type ISubscriptionRepository,
} from '../subscriptions/subscription.repository.interface';

interface ResourceEventPayload {
  sizeDelta?: number;
}

/**
 * §8.5 "Consumes": ResourceCreated/ResourceDeleted -> reconcile
 * used_storage_bytes. UNLIKE used_seats, this counter has "no such
 * [enforcement] constraint" (§8.5) — resource-service enforces its own
 * storage limit in its own transaction (§19.6), using its own
 * plan_limit_cache. This consumer's write here is a genuinely
 * eventually-consistent DISPLAY value, not an enforcement path — the
 * distinction §8.5 calls "the single most important thing to preserve when
 * extending this service."
 */
@Injectable()
export class StorageReconciliationConsumer extends BaseKafkaConsumer {
  protected readonly topic: KafkaTopic = KAFKA_TOPICS.RESOURCE;

  constructor(
    @Inject(KAFKA_CLIENT) options: KafkaModuleOptions,
    tenantContext: TenantContextStore,
    @Inject(CONSUMED_EVENT_STORE) consumedEvents: ConsumedEventStore,
    private readonly tenantDataSource: TenantAwareDataSource,
    @Inject(SUBSCRIPTION_REPOSITORY) private readonly subscriptions: ISubscriptionRepository,
  ) {
    super(options, tenantContext, consumedEvents);
  }

  protected async handle(envelope: EventEnvelope): Promise<void> {
    if (
      envelope.eventType !== EVENT_TYPES.RESOURCE_CREATED &&
      envelope.eventType !== EVENT_TYPES.RESOURCE_DELETED
    ) {
      return;
    }
    if (!envelope.organizationId) return;

    const organizationId = envelope.organizationId;
    const payload = envelope.payload as ResourceEventPayload;
    const delta =
      envelope.eventType === EVENT_TYPES.RESOURCE_CREATED
        ? (payload.sizeDelta ?? 0)
        : -(payload.sizeDelta ?? 0);

    await this.tenantDataSource.transactionForOrganization(organizationId, async (manager) => {
      const subscription = await this.subscriptions.findByOrganizationId(organizationId, manager);
      if (!subscription) return;
      // ck_subscriptions_storage enforces used_storage_bytes <= max_storage_snapshot
      // at the database level (§19.4's backstop). used_storage_bytes is a DISPLAY
      // value here (§8.5) — resource-service enforces the real limit in its own
      // transaction (§19.6) — but this UPDATE still writes into a column an
      // enforcement CHECK guards. Without the upper clamp, a lagging or
      // out-of-order event stream could push this write past the constraint,
      // throwing here and sending the event to the DLQ permanently (§17.6). A
      // display value must never be at the mercy of an enforcement constraint's
      // timing, so this consumer clamps to BOTH bounds the CHECK enforces.
      const next = Math.min(
        subscription.maxStorageSnapshot,
        Math.max(0, subscription.usedStorageBytes + delta),
      );
      await this.subscriptions.updateUsedStorageBytes(organizationId, next, manager);
    });
  }
}
