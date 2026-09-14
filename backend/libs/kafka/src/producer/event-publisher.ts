import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Kafka, Producer } from 'kafkajs';
import type { EventEnvelope, KafkaTopic } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import type { DomainEvent } from './domain-event';
import { KAFKA_CLIENT, type KafkaModuleOptions } from '../kafka.options';

/**
 * §17.5: publish AFTER commit, never inside a transaction. Application services
 * collect DomainEvent[] during their transaction and call publishAll() once it
 * has committed. Keyed by organizationId (§17.2) so a tenant's events stay
 * ordered on one partition.
 *
 * Failure behaviour (§30.2): if Kafka is unreachable, the request has ALREADY
 * succeeded (commit happened first) — publish failures are logged, never thrown
 * back to the caller. Audit must never fail a user request.
 */
@Injectable()
export class EventPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventPublisher.name);
  private readonly producer: Producer;

  constructor(
    @Inject(KAFKA_CLIENT) private readonly options: KafkaModuleOptions,
    private readonly tenantContext: TenantContextStore,
  ) {
    const kafka = new Kafka({
      clientId: `${options.clientIdPrefix}-${options.serviceName}`,
      brokers: options.brokers,
    });
    this.producer = kafka.producer({ allowAutoTopicCreation: false });
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
  }

  async publish<T>(topic: KafkaTopic, event: DomainEvent<T>): Promise<void> {
    await this.publishAll(topic, [event]);
  }

  async publishAll<T>(topic: KafkaTopic, events: DomainEvent<T>[]): Promise<void> {
    if (events.length === 0) return;

    const correlationId = this.tenantContext.get()?.correlationId ?? randomUUID();
    const now = new Date().toISOString();

    const messages = events.map((event) => {
      const envelope: EventEnvelope<T> = {
        eventId: randomUUID(),
        eventType: event.eventType,
        eventVersion: 1,
        organizationId: event.organizationId,
        correlationId,
        causationId: event.causationId,
        actorUserId: event.actorUserId,
        occurredAt: now,
        payload: event.payload,
      };
      return {
        key: event.organizationId ?? 'platform',
        value: JSON.stringify(envelope),
      };
    });

    try {
      await this.producer.send({ topic, messages });
    } catch (err) {
      // §30.2: never throw. The transaction already committed; a publish failure
      // is a durability gap for observability, not a correctness failure for the
      // user-facing request.
      this.logger.error(
        `Failed to publish ${events.length} event(s) to ${topic}: ${(err as Error).message}`,
      );
    }
  }
}
