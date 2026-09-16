import { Controller, Get, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '@app/redis';
import { Public } from '@app/auth';

/**
 * §26.4: liveness + readiness.
 *
 * @Public() here is correct and is NOT the §13.7-row-6 mistake. That rule forbids a
 * DOWNSTREAM service marking a route public, because there it bypasses
 * InternalContextGuard's signature verification — the system's one isolation control.
 * At the gateway, @Public() bypasses JwtAuthGuard, which is exactly the mechanism
 * §11.5 defines for opting a route out of client authentication, and these two routes
 * return booleans: no tenant data, no downstream call, nothing an exemption can leak.
 * Downstream services solve the same problem with a hardcoded path list instead
 * precisely because they have no legitimate @Public() route at all.
 *
 * §26.4 readiness, stated honestly: this service has NO database (§10.3), so there is
 * no schema to probe. What it can actually verify is Redis, and Redis genuinely
 * affects correctness here — RedisTokenDenylist fails CLOSED (§16.4), so with Redis
 * unreachable EVERY token is treated as revoked and every authenticated request 401s.
 * A gateway in that state is not ready, and reporting it as ready would be a lie that
 * costs an operator the outage's cause.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  @Get()
  @Public()
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  async readiness(): Promise<{ status: string; redis: boolean }> {
    const redis = await this.redis
      .ping()
      .then(() => true)
      .catch(() => false);
    return { status: redis ? 'ok' : 'degraded', redis };
  }
}
