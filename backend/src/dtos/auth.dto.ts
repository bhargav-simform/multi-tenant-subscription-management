import { IsEmail, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

export class RefreshDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}

export class LogoutDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;
}

/**
 * Input to credentials.service createCredentials() (formerly the internal
 * POST /internal/auth/credentials body). Deliberately no userId: it is minted at
 * credential creation, the earliest point the identity exists. organizationId is
 * absent only for a platform admin.
 */
export class CreateCredentialsDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12)
  password!: string;
}
