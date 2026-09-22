import { IsBooleanString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export const RESOURCE_SORT = {
  CREATED_AT: 'createdAt',
  SIZE_BYTES: 'sizeBytes',
} as const;

export type ResourceSort = (typeof RESOURCE_SORT)[keyof typeof RESOURCE_SORT];

/**
 * §29: keyset pagination — an opaque cursor, never a page number or offset.
 * `sort` picks the ORDER BY column; the cursor's encoding depends on which
 * column was active when it was minted (see ResourceRepository.listPage), so
 * changing `sort` mid-session must start a fresh cursor rather than reuse one
 * from a different sort — the frontend does this by resetting pagination
 * whenever the active sort changes.
 */
export class ListResourcesQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(Object.values(RESOURCE_SORT))
  sort?: ResourceSort;

  /** When 'true', only resources with no description. Server-side — never a client-side filter over one page. */
  @IsOptional()
  @IsBooleanString()
  hasDescription?: string;
}
