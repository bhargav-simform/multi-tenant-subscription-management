import { IsEmail, IsEnum } from 'class-validator';
import { UserRole } from '../user.entity';

/** §19.2: ValidationPipe rejects malformed input before the transaction opens. */
export class InviteUserDto {
  @IsEmail()
  email!: string;

  @IsEnum(UserRole)
  role!: UserRole;
}
