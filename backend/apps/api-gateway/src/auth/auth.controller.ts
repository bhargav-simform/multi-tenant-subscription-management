import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
} from '@nestjs/common';
import { CurrentUser, Public, TOKEN_DENYLIST } from '@app/auth';
import type { JwtAccessPayload, TokenDenylist } from '@app/auth';
import { ProxyService } from '../proxy/proxy.service';

/**
 * §10.2/§11.2. Thin pass-through: auth-service's own ValidationPipe validates the
 * bodies (§10.3 — the gateway re-declaring LoginDto would be two copies of the same
 * rules drifting apart), so nothing here inspects a credential. The one piece of
 * genuine gateway work is the logout denylist write below, which is the gateway's
 * responsibility by §11.4 and nobody else's.
 */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly proxy: ProxyService,
    @Inject(TOKEN_DENYLIST) private readonly denylist: TokenDenylist,
  ) {}

  /**
   * §11.5: one of exactly three @Public() routes — you cannot authenticate to
   * authenticate. §10.2's strict throttle bucket covers this route (it is the one
   * place an unauthenticated caller can test a password); the bucket is applied
   * from common/throttle-routes.ts, not by a decorator here — see that file.
   */
  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  login(@Body() body: unknown): Promise<unknown> {
    return this.proxy.forward({ service: 'auth', method: 'POST', path: '/auth/login', body });
  }

  /**
   * DOCUMENTED DISCREPANCY, resolved here — see ARCHITECTURE.md §32.3 for the
   * tracked note.
   *
   * §11.5's table names exactly THREE @Public() routes and /auth/refresh is not
   * among them, but §8.1's endpoint table lists this route's auth as
   * "public (refresh token)", and auth-service's own AuthController doc comment
   * says /refresh is reachable "because the gateway signs an ANONYMOUS context"
   * for it — which is only true of a route the gateway treats as unauthenticated.
   * The two statements cannot both be literally true.
   *
   * Resolved in favour of the behaviour that makes the system work: this route is
   * @Public() at the gateway. The caller's credential on a refresh IS the refresh
   * token in the body, not an access token in the Authorization header. JwtAuthGuard's
   * Passport strategy validates an ACCESS token (libs/auth's JwtStrategy, 15-minute
   * TTL) — requiring one here would mean a client whose access token has just expired
   * could never refresh it, which is the only situation in which refresh is ever
   * called. The refresh token is verified properly, with single-use rotation and
   * theft detection, by auth-service (§11.4) — the component that actually owns it.
   *
   * §11.5's "no anonymous path beyond the onboarding/signup flow" claim is not
   * weakened: this route asserts no identity, reads no tenant data, and its body is
   * a token auth-service itself minted and stores hashed. It is an authentication
   * route like /auth/login, not a data route.
   */
  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: unknown): Promise<unknown> {
    return this.proxy.forward({ service: 'auth', method: 'POST', path: '/auth/refresh', body });
  }

  /**
   * AUTHENTICATED — deliberately not @Public(), unlike /refresh above. Logout needs
   * the CALLER'S OWN verified access token, because §11.4/§16.2's immediate-revocation
   * mechanism denylists that token's `jti`, and a jti is only trustworthy if it came
   * out of a signature-verified token. Accepting an unverified one would let anyone
   * revoke anyone else's session by guessing or replaying a jti.
   *
   * §32.3 tracked this as an open gap ("nothing calls deny() yet, since the gateway
   * itself is not built"). This is the call. auth-service's own logout revokes the
   * REFRESH token (the half it owns); the access-token denylist write is the
   * gateway's half and exists nowhere else.
   *
   * Order matters: deny FIRST, then proxy. If the downstream call fails, the caller's
   * access token is already dead — failing safe. Denying after a successful proxy
   * would leave a window in which the refresh token is revoked but the access token
   * still works.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: JwtAccessPayload,
    @Body() body: unknown,
  ): Promise<void> {
    await this.denyOwnAccessToken(user);
    await this.proxy.forward({ service: 'auth', method: 'POST', path: '/auth/logout', body });
  }

  /**
   * TTL is the token's own REMAINING lifetime, not a fixed value: a denylist entry
   * outliving the token it revokes wastes Redis, and one expiring early reopens the
   * window logout exists to close. Guarded against a non-positive TTL, which would
   * make ioredis' SET ... EX throw and turn an already-expired-but-somehow-verified
   * token into a 500.
   */
  private async denyOwnAccessToken(user: JwtAccessPayload): Promise<void> {
    const remainingTtl = user.exp - Math.floor(Date.now() / 1000);
    if (remainingTtl <= 0) return;

    try {
      await this.denylist.deny(user.jti, remainingTtl);
    } catch (err) {
      // §16.4: Redis being down must not make logout impossible. The refresh token
      // is still revoked downstream, so the session cannot be extended; the access
      // token simply lives out its remaining TTL. Logged as it is a real degradation.
      this.logger.error(
        `Failed to denylist access token jti=${user.jti}: ${(err as Error).message}`,
      );
    }
  }
}
