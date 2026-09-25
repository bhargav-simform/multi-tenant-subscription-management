import { IsString, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  /** Matches the credential password rule (MinLength 12). */
  @IsString()
  @MinLength(12)
  password!: string;
}
