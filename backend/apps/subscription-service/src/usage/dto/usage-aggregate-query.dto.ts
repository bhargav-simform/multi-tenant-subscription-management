import { IsOptional, IsUUID } from 'class-validator';

/** If organizationId is omitted, returns aggregates for ALL organisations (§8.5, R9). */
export class UsageAggregateQueryDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
