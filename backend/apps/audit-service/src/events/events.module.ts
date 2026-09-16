import { Module } from '@nestjs/common';
import { CONSUMED_EVENT_STORE } from '@app/kafka';
import { AuditModule } from '../audit/audit.module';
import { PostgresConsumedEventStore } from './postgres-consumed-event.store';
import {
  OrganizationEventsConsumer,
  ResourceEventsConsumer,
  SubscriptionEventsConsumer,
  UserEventsConsumer,
} from './content-topic.consumers';
import { SecurityEventsConsumer } from './security-events.consumer';

/**
 * §8.7 "Consumes: every topic" — all five, one concrete consumer each, because
 * BaseKafkaConsumer subscribes to exactly one topic per instance.
 *
 * This module is the ONLY writer in audit-service. There is no EventPublisher
 * here and there must not be one: §8.7 says "Publishes: nothing. It is a pure
 * sink."
 */
@Module({
  imports: [AuditModule],
  providers: [
    OrganizationEventsConsumer,
    UserEventsConsumer,
    SubscriptionEventsConsumer,
    ResourceEventsConsumer,
    SecurityEventsConsumer,
    { provide: CONSUMED_EVENT_STORE, useClass: PostgresConsumedEventStore },
  ],
})
export class EventsModule {}
