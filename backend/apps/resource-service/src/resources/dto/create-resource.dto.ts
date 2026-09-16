import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * §13.7 row 6: NO `organizationId` FIELD, EVER. The organisation comes from
 * TenantContext.get(), which comes from the signed internal context header,
 * which comes from a JWT claim (§13.3) — never from a request body. The
 * global ValidationPipe's forbidNonWhitelisted REJECTS a smuggled
 * organizationId rather than silently stripping it, but the real rule is that
 * it must never be declared here in the first place.
 *
 * `createdBy` is likewise absent — it is taken from the acting user's id in
 * tenant context, not accepted from the caller, or a member could plant a
 * resource attributed to someone else and evade CASL's ownership rule (§12.3).
 */
export class CreateResourceDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  /**
   * Byte count. @IsInt rejects a float or a numeric string outright, which
   * matters because this value is added to the authoritative
   * used_storage_bytes counter (§19.6) — a non-integer would corrupt it, and
   * assertSafeInt in the repository is the second line of defence.
   * @Min(0) matches the ck_resources_size_nonneg CHECK constraint.
   */
  @IsInt()
  @Min(0)
  sizeBytes!: number;
}
