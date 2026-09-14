import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

// @nestjs/throttler defines ThrottlerStorageRecord but does not re-export it from
// the package root in the installed version — mirrored locally to match the
// ThrottlerStorage.increment() return shape exactly.
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * §16.2 use #1: shared rate-limit state across gateway replicas. Without this,
 * @nestjs/throttler's default in-memory store is per-process, and the configured
 * limit becomes N times too generous with N replicas.
 *
 * §16.4: fails OPEN. A rate limiter is a protection, not a correctness control —
 * failing closed here would turn a Redis blip into a total outage for every
 * request through the gateway.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const storageKey = `throttle:${throttlerName}:${key}`;
    try {
      const totalHits = await this.redis.incr(storageKey);
      if (totalHits === 1) {
        await this.redis.pexpire(storageKey, ttl);
      }
      const timeToExpire = await this.redis.pttl(storageKey);

      const isBlocked = totalHits > limit;
      let timeToBlockExpire = 0;
      if (isBlocked && blockDuration > 0) {
        const blockKey = `${storageKey}:blocked`;
        const blocked = await this.redis.set(blockKey, '1', 'PX', blockDuration, 'NX');
        timeToBlockExpire = blocked ? blockDuration : await this.redis.pttl(blockKey);
      }

      return {
        totalHits,
        timeToExpire: timeToExpire > 0 ? timeToExpire : ttl,
        isBlocked,
        timeToBlockExpire,
      };
    } catch (err) {
      // Fail open (§16.4): allow the request rather than block all traffic.
      this.logger.warn(`Rate limit check failed, failing open: ${(err as Error).message}`);
      return { totalHits: 0, timeToExpire: ttl, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
