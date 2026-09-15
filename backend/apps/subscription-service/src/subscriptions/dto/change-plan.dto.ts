import { IsEnum } from 'class-validator';
import { PlanCode } from '../../plans/plan.entity';

export class ChangePlanDto {
  @IsEnum(PlanCode)
  planCode!: PlanCode;
}
