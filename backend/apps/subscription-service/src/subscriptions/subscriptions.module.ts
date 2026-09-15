import { Module } from '@nestjs/common';
import { SubscriptionsController, InternalSubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionRepository } from './subscription.repository';
import { SUBSCRIPTION_REPOSITORY } from './subscription.repository.interface';
import { SubscriptionHistoryRepository } from './subscription-history.repository';
import { SUBSCRIPTION_HISTORY_REPOSITORY } from './subscription-history.repository.interface';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [PlansModule],
  controllers: [SubscriptionsController, InternalSubscriptionsController],
  providers: [
    SubscriptionsService,
    { provide: SUBSCRIPTION_REPOSITORY, useClass: SubscriptionRepository },
    { provide: SUBSCRIPTION_HISTORY_REPOSITORY, useClass: SubscriptionHistoryRepository },
  ],
  exports: [SUBSCRIPTION_REPOSITORY],
})
export class SubscriptionsModule {}
