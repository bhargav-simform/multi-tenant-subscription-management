import { Module } from '@nestjs/common';
import { CONSUMED_EVENT_STORE } from '@app/kafka';
import { SubscriptionChangedConsumer } from './subscription-changed.consumer';
import { PostgresConsumedEventStore } from './postgres-consumed-event.store';
import { ResourcesModule } from '../resources/resources.module';

@Module({
  imports: [ResourcesModule],
  providers: [
    SubscriptionChangedConsumer,
    { provide: CONSUMED_EVENT_STORE, useClass: PostgresConsumedEventStore },
  ],
})
export class EventsModule {}
