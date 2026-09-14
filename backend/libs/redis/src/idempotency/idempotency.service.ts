import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../client/redis.provider';
import { platformKey } from '../client/redis-key.helper';

const ONBOARDING_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // §16.2 use #3

/**
 * §16.2 use #3: prevents a double-submitted signup from creating two
 * organisations. Redis is the fast path; the real guarantee is the unique
 * constraint on onboarding_sagas.idempotency_key (§16.4) — if Redis is down,
 * the database catches the duplicate anyway, just with a slower round trip.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Returns true if this key was NOT seen before (i.e. this call claimed it). */
  async claim(key: string): Promise<boolean> {
    const result = await this.redis.set(
      platformKey('idempotency', key),
      '1',
      'EX',
      ONBOARDING_IDEMPOTENCY_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }
}
