import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** forbidNonWhitelisted: a smuggled organizationId field is rejected, not stripped. */
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

  /** Generated once per signup form submission, so a network retry resumes the same saga. */
  @IsString()
  @Matches(/^[a-zA-Z0-9-]{8,128}$/)
  idempotencyKey!: string;
}
