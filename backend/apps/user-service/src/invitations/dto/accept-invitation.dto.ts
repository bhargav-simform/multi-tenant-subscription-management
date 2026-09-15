import { IsString, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;
}
