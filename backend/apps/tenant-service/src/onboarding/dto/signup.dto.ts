import { IsEmail, IsString, Matches, MinLength, MaxLength } from 'class-validator';

/**
 * §25.1: rejected here, before any business logic runs. class-validator +
 * global ValidationPipe with forbidNonWhitelisted means a smuggled
 * organizationId field is REJECTED, not silently stripped (§13.7 row 6 closed).
 */
export class SignupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  organizationName!: string;

  @IsEmail()
  adminEmail!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(255)
  adminPassword!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  adminFirstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  adminLastName!: string;

  /**
   * Client-supplied idempotency key (e.g. a UUID generated once per signup form
   * submission) so a network retry resumes the same saga rather than creating a
   * second organisation (§16.2 use #3, §30.1).
   */
  @IsString()
  @Matches(/^[a-zA-Z0-9-]{8,128}$/)
  idempotencyKey!: string;
}
