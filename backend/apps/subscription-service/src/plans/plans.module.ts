import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlanRepository } from './plan.repository';
import { PLAN_REPOSITORY } from './plan.repository.interface';

@Module({
  controllers: [PlansController],
  providers: [{ provide: PLAN_REPOSITORY, useClass: PlanRepository }],
  exports: [PLAN_REPOSITORY],
})
export class PlansModule {}
