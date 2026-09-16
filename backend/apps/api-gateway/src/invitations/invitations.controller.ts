import { Body, Controller, Param, Post } from '@nestjs/common';
import { Public } from '@app/auth';
import { ProxyService } from '../proxy/proxy.service';

/**
 * §11.5: the third and last @Public() route. An invitee has no account yet, so
 * there is no token to require — the invitation TOKEN is the credential. It is
 * single-use, hashed at rest, expiring (D-Q7), and resolves to exactly one
 * invitation in exactly one organisation, so it carries its own tenant scope.
 * The gateway does not and cannot validate it: doing so would mean knowing what
 * an invitation is (§10.3). user-service resolves it.
 *
 * As with the other two public routes, no ALS scope is opened, so
 * InternalHttpClient signs an ANONYMOUS context (§9.4) that user-service's
 * InternalContextGuard verifies exactly like any other request.
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly proxy: ProxyService) {}

  @Post(':token/accept')
  @Public()
  accept(@Param('token') token: string, @Body() body: unknown): Promise<unknown> {
    return this.proxy.forward({
      service: 'user',
      method: 'POST',
      path: `/invitations/${encodeURIComponent(token)}/accept`,
      body,
    });
  }
}
