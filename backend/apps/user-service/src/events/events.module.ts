import { Module } from '@nestjs/common';
import { CONSUMED_EVENT_STORE } from '@app/kafka';
import { OrganizationProvisionedConsumer } from './organization-provisioned.consumer';
import { PostgresConsumedEventStore } from './postgres-consumed-event.store';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  providers: [
    OrganizationProvisionedConsumer,
    { provide: CONSUMED_EVENT_STORE, useClass: PostgresConsumedEventStore },
  ],
})
export class EventsModule {}
