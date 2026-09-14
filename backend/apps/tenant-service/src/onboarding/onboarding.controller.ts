import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '@app/tenant-context';
import { SignupDto } from './dto/signup.dto';
import { SignupResponseDto } from './dto/signup-response.dto';
import { OnboardingService } from './onboarding.service';

/**
 * §11.5: one of exactly three @Public() routes in the entire system. A new
 * organisation must be able to onboard itself with no engineering involvement
 * (brief §3.2) — this is the auditable exception, not a gap in coverage.
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Public()
  @Post('signup')
  signup(@Body() dto: SignupDto): Promise<SignupResponseDto> {
    return this.onboarding.signup(dto);
  }
}
