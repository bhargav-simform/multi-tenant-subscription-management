import { IsEnum } from 'class-validator';
import { PlanCode } from '../generated/prisma/enums';

export class ChangePlanDto {
  @IsEnum(PlanCode)
  planCode!: PlanCode;
}
