import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingSagaRepository, ONBOARDING_SAGA_REPOSITORY } from './onboarding-saga.repository';
import { AUTH_CLIENT } from './auth-client.interface';
import { SUBSCRIPTION_CLIENT } from './subscription-client.interface';
import { HttpAuthClient } from './clients/http-auth.client';
import { HttpSubscriptionClient } from './clients/http-subscription.client';

/**
 * No HttpModule import here — HttpAuthClient/HttpSubscriptionClient inject
 * InternalHttpClient (§9.4), provided globally by TenantContextModule, not
 * raw HttpService.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [OnboardingController],
  providers: [
    OnboardingService,
    { provide: ONBOARDING_SAGA_REPOSITORY, useClass: OnboardingSagaRepository },
    { provide: AUTH_CLIENT, useClass: HttpAuthClient },
    { provide: SUBSCRIPTION_CLIENT, useClass: HttpSubscriptionClient },
  ],
})
export class OnboardingModule {}
