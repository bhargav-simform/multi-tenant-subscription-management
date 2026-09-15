import { Module } from '@nestjs/common';
import { CONSUMED_EVENT_STORE } from '@app/kafka';
import { MissingSubscriptionAlarmConsumer } from './missing-subscription-alarm.consumer';
import { StorageReconciliationConsumer } from './storage-reconciliation.consumer';
import { PostgresConsumedEventStore } from './postgres-consumed-event.store';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [SubscriptionsModule],
  providers: [
    MissingSubscriptionAlarmConsumer,
    StorageReconciliationConsumer,
    { provide: CONSUMED_EVENT_STORE, useClass: PostgresConsumedEventStore },
  ],
})
export class EventsModule {}
