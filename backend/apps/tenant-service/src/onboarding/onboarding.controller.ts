import { Body, Controller, Post } from '@nestjs/common';
import { SignupDto } from './dto/signup.dto';
import { SignupResponseDto } from './dto/signup-response.dto';
import { OnboardingService } from './onboarding.service';

/**
 * §11.5: this is one of exactly three routes the CLIENT reaches with no
 * authenticated identity — but that "public" status belongs to api-gateway
 * alone (its JwtAuthGuard, its own @Public() from libs/auth), never to a
 * downstream service's own InternalContextGuard (§13.7 row 6). This
 * controller previously carried @app/tenant-context's Public() decorator,
 * which is a real, already-committed defect: it skipped signature
 * verification for this route entirely, so anyone able to reach this
 * service directly (bypassing the gateway) could call it with no
 * x-internal-context signature at all. Fixed by removing the decorator —
 * the gateway signs an ANONYMOUS context for this route (§9.4), and this
 * service's InternalContextGuard verifies that signature exactly like any
 * other request; the handler simply has no caller identity to read.
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('signup')
  signup(@Body() dto: SignupDto): Promise<SignupResponseDto> {
    return this.onboarding.signup(dto);
  }
}
