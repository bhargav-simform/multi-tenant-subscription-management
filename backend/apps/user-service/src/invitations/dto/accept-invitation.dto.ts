import { IsString, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  /** Matches CreateCredentialsDto's own MinLength(12) — the invitee's login password. */
  @IsString()
  @MinLength(12)
  password!: string;
}
