import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingSagaRepository, ONBOARDING_SAGA_REPOSITORY } from './onboarding-saga.repository';
import { AUTH_CLIENT } from './auth-client.interface';
import { SUBSCRIPTION_CLIENT } from './subscription-client.interface';
import { HttpAuthClient } from './clients/http-auth.client';
import { HttpSubscriptionClient } from './clients/http-subscription.client';

@Module({
  imports: [HttpModule, OrganizationsModule],
  controllers: [OnboardingController],
  providers: [
    OnboardingService,
    { provide: ONBOARDING_SAGA_REPOSITORY, useClass: OnboardingSagaRepository },
    { provide: AUTH_CLIENT, useClass: HttpAuthClient },
    { provide: SUBSCRIPTION_CLIENT, useClass: HttpSubscriptionClient },
  ],
})
export class OnboardingModule {}
