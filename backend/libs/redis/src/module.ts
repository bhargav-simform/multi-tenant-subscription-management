import { Global, Module } from '@nestjs/common';
import { redisProvider } from './client/redis.provider';
import { RedisTokenDenylist } from './denylist/redis-token-denylist';
import { IdempotencyService } from './idempotency/idempotency.service';
import { TOKEN_DENYLIST } from '@app/auth';

@Global()
@Module({
  providers: [
    redisProvider,
    IdempotencyService,
    { provide: TOKEN_DENYLIST, useClass: RedisTokenDenylist },
  ],
  exports: [redisProvider, IdempotencyService, TOKEN_DENYLIST],
})
export class RedisModule {}
