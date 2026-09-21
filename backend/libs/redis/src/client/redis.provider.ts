import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import type { Provider } from '@nestjs/common';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Redis({
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: Number(config.getOrThrow('REDIS_PORT')),
      // §16.4: rate limiting must fail OPEN, denylist must fail CLOSED. Neither
      // behaviour lives here — it lives in each consumer's error handling, this
      // client just avoids crashing the process on a transient Redis blip.
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    }),
};
