import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { TokenDenylist } from '@app/auth';
import { REDIS_CLIENT } from '../client/redis.provider';
import { platformKey } from '../client/redis-key.helper';

/**
 * §16.2 use #2, §16.4 failure mode: fails CLOSED. If Redis is unreachable, isDenied
 * returns true — a token that cannot be checked is treated as revoked rather than
 * as valid, since the alternative (fail open) would make logout meaningless during
 * an outage. The max blast radius is a 15-minute access token TTL either way.
 */
@Injectable()
export class RedisTokenDenylist implements TokenDenylist {
  private readonly logger = new Logger(RedisTokenDenylist.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async isDenied(jti: string): Promise<boolean> {
    try {
      const exists = await this.redis.exists(platformKey('denylist', jti));
      return exists === 1;
    } catch (err) {
      this.logger.warn(`Denylist check failed, failing closed: ${(err as Error).message}`);
      return true;
    }
  }

  async deny(jti: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(platformKey('denylist', jti), '1', 'EX', ttlSeconds);
  }
}
