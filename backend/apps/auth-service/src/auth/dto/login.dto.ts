import { IsEmail, IsString, MinLength } from 'class-validator';

/** §11.2: ValidationPipe rejects malformed input before business logic. */
export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
