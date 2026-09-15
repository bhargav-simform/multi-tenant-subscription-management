import { IsUUID } from 'class-validator';

/** §8.5: internal-only, called by tenant-service's onboarding saga. */
export class AssignDefaultPlanDto {
  @IsUUID()
  organizationId!: string;
}
