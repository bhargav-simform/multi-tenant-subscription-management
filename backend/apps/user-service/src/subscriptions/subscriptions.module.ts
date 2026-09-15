import { Module } from '@nestjs/common';
import { SubscriptionSeatRepository } from './subscription-seat.repository';
import { SUBSCRIPTION_SEAT_REPOSITORY } from './subscription-seat.repository.interface';

@Module({
  providers: [{ provide: SUBSCRIPTION_SEAT_REPOSITORY, useClass: SubscriptionSeatRepository }],
  exports: [SUBSCRIPTION_SEAT_REPOSITORY],
})
export class SubscriptionsModule {}
