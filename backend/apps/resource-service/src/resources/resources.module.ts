import { Module } from '@nestjs/common';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';
import { ResourceRepository } from './resource.repository';
import { RESOURCE_REPOSITORY } from './resource.repository.interface';
import { PlanLimitCacheRepository } from './plan-limit-cache.repository';
import { PLAN_LIMIT_CACHE_REPOSITORY } from './plan-limit-cache.repository.interface';

/**
 * §20.2: repositories are bound to their INTERFACE tokens, never injected as
 * concrete classes — the service depends on IResourceRepository /
 * IPlanLimitCacheRepository and knows nothing about TypeORM.
 *
 * PLAN_LIMIT_CACHE_REPOSITORY is exported because EventsModule's
 * SubscriptionChangedConsumer needs it to refresh the ceiling (§8.6).
 */
@Module({
  controllers: [ResourcesController],
  providers: [
    ResourcesService,
    { provide: RESOURCE_REPOSITORY, useClass: ResourceRepository },
    { provide: PLAN_LIMIT_CACHE_REPOSITORY, useClass: PlanLimitCacheRepository },
  ],
  exports: [RESOURCE_REPOSITORY, PLAN_LIMIT_CACHE_REPOSITORY, ResourcesService],
})
export class ResourcesModule {}
