import { Controller, Get } from '@nestjs/common';
import { PLAN_REPOSITORY, type IPlanRepository } from './plan.repository.interface';
import { Inject } from '@nestjs/common';
import type { PlanResponseDto } from './dto/plan-response.dto';
import type { Plan } from './plan.entity';

@Controller('plans')
export class PlansController {
  constructor(@Inject(PLAN_REPOSITORY) private readonly plans: IPlanRepository) {}

  /** §8.5: public catalogue — reachable by any authenticated caller, no CASL check needed. */
  @Get()
  async list(): Promise<PlanResponseDto[]> {
    const plans = await this.plans.findAll();
    return plans.map(toDto);
  }
}

function toDto(plan: Plan): PlanResponseDto {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    maxUsers: plan.maxUsers,
    maxStorageBytes: plan.maxStorageBytes,
  };
}
