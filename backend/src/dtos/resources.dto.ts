import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RESOURCE_SORT, type ResourceSort } from '../models/resource.model';

/**
 * No organizationId and no createdBy, ever: both come from the token.
 * forbidNonWhitelisted rejects a smuggled one.
 */
export class CreateResourceDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** @IsInt rejects floats and numeric strings: this is added to the storage counter. */
  @IsInt()
  @Min(0)
  sizeBytes!: number;
}

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

  /** 'true' = only resources with a description, 'false' = only without. Server-side filter. */
  @IsOptional()
  @IsBooleanString()
  hasDescription?: string;
}
