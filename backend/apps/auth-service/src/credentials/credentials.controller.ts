import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { CreateCredentialsDto } from './dto/create-credentials.dto';
import { CreateCredentialsResponseDto } from './dto/create-credentials-response.dto';

/**
 * §8.2: internal-only, called by tenant-service's onboarding saga (§9.2).
 * No @Public() — the caller is another service, authenticated by
 * InternalContextGuard's signature verification exactly like every other
 * inter-service call (§9.4, §13.7 row 6).
 */
@Controller('internal/auth')
export class CredentialsController {
  constructor(private readonly auth: AuthService) {}

  @Post('credentials')
  createCredentials(@Body() dto: CreateCredentialsDto): Promise<CreateCredentialsResponseDto> {
    return this.auth.createCredentials(dto);
  }
}
