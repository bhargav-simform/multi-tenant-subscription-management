import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * §29: keyset pagination — an opaque cursor, never a page number or offset.
 *
 * §13.7 row 6: deliberately NO `organizationId` field, and no field that could
 * stand in for one. The organisation is implied by the caller's token and read
 * from TenantContextStore; a platform admin's cross-org view is selected by
 * their ROLE, not by a parameter they can supply. `forbidNonWhitelisted` on the
 * global ValidationPipe rejects a smuggled one rather than stripping it, but the
 * first line of defence is that it is not declared here at all.
 */
export class ListAuditQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
