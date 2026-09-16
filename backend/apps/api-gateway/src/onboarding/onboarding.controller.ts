import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '@app/auth';
import { ProxyService } from '../proxy/proxy.service';

/**
 * §11.5: one of exactly three @Public() routes — the brief's stated exception, an
 * organisation must be able to onboard itself with no engineering involvement (R3).
 *
 * @Public() here is libs/auth's, which opts this route out of the gateway's own
 * JwtAuthGuard. It is emphatically NOT libs/tenant-context's Public(): a downstream
 * service carrying that decorator skips InternalContextGuard's signature check
 * entirely (§13.7 row 6) — a real defect that was found on tenant-service's own
 * OnboardingController and removed. That controller now expects a signed ANONYMOUS
 * context from this route, which it gets automatically: no ALS scope is open on a
 * public route, so InternalHttpClient signs anonymous (§9.4).
 *
 * §10.2's strict throttle bucket covers this route — a public write that creates an
 * organisation. Applied from common/throttle-routes.ts, not by a decorator here.
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly proxy: ProxyService) {}

  @Post('signup')
  @Public()
  signup(@Body() body: unknown): Promise<unknown> {
    return this.proxy.forward({
      service: 'tenant',
      method: 'POST',
      path: '/onboarding/signup',
      body,
    });
  }
}
