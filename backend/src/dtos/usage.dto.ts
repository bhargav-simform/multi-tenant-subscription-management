import { IsOptional, IsUUID } from 'class-validator';

/** If organizationId is omitted, returns aggregates for ALL organisations. */
export class UsageAggregateQueryDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
