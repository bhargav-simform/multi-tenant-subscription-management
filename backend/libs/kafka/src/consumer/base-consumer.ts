import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Consumer, EachMessagePayload, Kafka } from 'kafkajs';
import type { EventEnvelope, KafkaTopic } from '@app/common';
import { dlqTopic } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import type { KafkaModuleOptions } from '../kafka.options';
import type { ConsumedEventStore } from './consumed-event-store.interface';

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 5000, 25000];

/**
 * §17.6: at-least-once delivery, so every handler MUST be idempotent — enforced
 * here via consumed_events(event_id) dedupe, not left to each subclass.
 *
 * §13.4 "across Kafka": consumers are NOT inside an HTTP request and inherit no
 * ambient tenant context. This base class opens an ALS scope from
 * envelope.organizationId BEFORE invoking handle() — a subclass's handle() must
 * never receive an unscoped payload, and must never call als.run() itself.
 *
 * Manual offset commit after successful processing (§17.6) — kafkajs's
 * eachMessage with autoCommit disabled gives us that; a crash mid-handler replays
 * rather than silently skipping.
 */
export abstract class BaseKafkaConsumer implements OnModuleInit, OnModuleDestroy {
  protected abstract readonly topic: KafkaTopic;
  protected readonly logger = new Logger(this.constructor.name);
  private readonly consumer: Consumer;

  constructor(
    private readonly options: KafkaModuleOptions,
    private readonly tenantContext: TenantContextStore,
    private readonly consumedEvents: ConsumedEventStore,
  ) {
    const kafka = new Kafka({
      clientId: `${options.clientIdPrefix}-${options.serviceName}`,
      brokers: options.brokers,
    });
    this.consumer = kafka.consumer({ groupId: options.groupId });
  }

  /** Implemented by each concrete consumer. Runs INSIDE the tenant ALS scope. */
  protected abstract handle(envelope: EventEnvelope): Promise<void>;

  async onModuleInit(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });
    await this.consumer.run({
      autoCommit: false,
      eachMessage: (payload) => this.processMessage(payload),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }

  private async processMessage({ message, partition, topic }: EachMessagePayload): Promise<void> {
    if (!message.value) return;
    const envelope = JSON.parse(message.value.toString('utf8')) as EventEnvelope;

    if (await this.consumedEvents.wasConsumed(envelope.eventId)) {
      this.logger.debug(`Skipping already-consumed event ${envelope.eventId}`);
      await this.commit(topic, partition, message.offset);
      return;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // §13.4: open tenant scope from the envelope, not from ambient state.
        // organizationId is null only for platform-scoped security events.
        await this.tenantContext.run(
          {
            userId: envelope.actorUserId ?? 'system',
            organizationId: envelope.organizationId,
            roles: [],
            correlationId: envelope.correlationId,
            iat: 0,
            exp: 0,
          },
          () => this.handle(envelope),
        );
        await this.consumedEvents.markConsumed(envelope.eventId);
        await this.commit(topic, partition, message.offset);
        return;
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          this.logger.error(
            `Event ${envelope.eventId} (${envelope.eventType}) failed after ${MAX_RETRIES} retries, sending to DLQ: ${(err as Error).message}`,
          );
          await this.sendToDlq(envelope);
          await this.commit(topic, partition, message.offset);
          return;
        }
        this.logger.warn(
          `Event ${envelope.eventId} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${(err as Error).message}`,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    await this.consumer.commitOffsets([
      { topic, partition, offset: (Number(offset) + 1).toString() },
    ]);
  }

  private async sendToDlq(envelope: EventEnvelope): Promise<void> {
    // Producing to the DLQ reuses the same broker connection info; a dedicated
    // lightweight producer is created lazily to avoid coupling every consumer to
    // EventPublisher's full transactional-outbox semantics.
    const kafka = new Kafka({
      clientId: `${this.options.clientIdPrefix}-${this.options.serviceName}-dlq`,
      brokers: this.options.brokers,
    });
    const producer = kafka.producer();
    await producer.connect();
    try {
      await producer.send({
        topic: dlqTopic(this.topic),
        messages: [{ key: envelope.organizationId ?? 'platform', value: JSON.stringify(envelope) }],
      });
    } finally {
      await producer.disconnect();
    }
  }
}
