import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { JwtAccessPayload } from '../jwt-payload.type';
import type { TokenDenylist } from './token-denylist.interface';
import { TOKEN_DENYLIST } from './token-denylist.interface';
import { Inject } from '@nestjs/common';

/**
 * §11.5: lives in api-gateway ONLY. This is the only place a client-supplied JWT
 * is trusted (§10.1). Downstream services never see this strategy — they trust
 * only the gateway's signed x-internal-context header (InternalContextGuard).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @Inject(TOKEN_DENYLIST) private readonly denylist: TokenDenylist,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtAccessPayload): Promise<JwtAccessPayload> {
    // §16.2: immediate logout via a Redis denylist keyed by jti — otherwise a
    // logged-out token stays valid until its natural 15-minute expiry.
    const isDenied = await this.denylist.isDenied(payload.jti);
    if (isDenied) {
      throw new UnauthorizedException('Token has been revoked');
    }
    return payload;
  }
}
