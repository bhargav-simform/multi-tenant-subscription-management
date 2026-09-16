import type { ExecutionContext } from '@nestjs/common';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import type { Request } from 'express';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { HttpModule } from '@nestjs/axios';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import type { Redis } from 'ioredis';
import { TenantContextModule } from '@app/tenant-context';
import { RedisModule, RedisThrottlerStorage, REDIS_CLIENT } from '@app/redis';
import { JwtAuthGuard, JwtStrategy } from '@app/auth';
import { buildPinoConfig, CorrelationIdMiddleware } from '@app/logging';
import { ProxyService } from './proxy/proxy.service';
import { DownstreamConfig } from './proxy/downstream.config';
import { TenantContextInterceptor } from './common/tenant-context.interceptor';
import { PlatformAdminGuard } from './common/platform-admin.guard';
import { AuthController } from './auth/auth.controller';
import { OnboardingController } from './onboarding/onboarding.controller';
import { InvitationsController } from './invitations/invitations.controller';
import { OrganizationsController } from './organizations/organizations.controller';
import { UsersController } from './users/users.controller';
import { SubscriptionsController } from './subscriptions/subscriptions.controller';
import { ResourcesController } from './resources/resources.controller';
import { AuditController } from './audit/audit.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { HealthController } from './health.controller';
import { isStrictThrottlePath, isUnthrottledPath } from './common/throttle-routes';

/**
 * §10: the ONLY public-facing service, the ONLY one with no database, and the ONLY
 * one that verifies a raw client JWT.
 *
 * WHAT IS DELIBERATELY ABSENT, per §10.3 — each of these appears in all six other
 * services' AppModule and must never appear here:
 *
 *   - TypeOrmModule / DatabaseModule / any entity / TenantAwareDataSource / the
 *     assertRlsSafeRole() boot check. No database means no RLS to protect, and
 *     adding one would make this the second place tenant data can be read.
 *   - InternalContextGuard. This service MINTS the signed context; it does not
 *     receive one. JwtAuthGuard takes its place as the global APP_GUARD (§11.5).
 *   - TenantContextMiddleware. It reads req.tenantContext, which only
 *     InternalContextGuard sets. TenantContextInterceptor replaces it, sourcing
 *     context from the verified JWT instead — see that file for why an interceptor
 *     and not middleware.
 *   - CaslAbilityGuard / AuthorizationModule / CaslAbilityFactory. Fine-grained
 *     authorisation stays downstream (§12.4) where the subject actually exists. The
 *     gateway's only authorisation is the coarse PlatformAdminGuard (§10.2).
 *   - KafkaModule. §8.1: "the gateway is not a Kafka participant — it has no domain
 *     events of its own, and giving it any would be business logic."
 *
 * GLOBAL GUARD ORDER (APP_GUARD providers execute in registration order):
 *   1. ThrottlerGuard — rate-limit before spending any work on a request (§10.2).
 *   2. JwtAuthGuard   — verify signature, expiry and the Redis denylist (§11.5).
 * Then APP_INTERCEPTOR TenantContextInterceptor opens the ALS scope from the payload
 * JwtAuthGuard just attached. Interceptors run after ALL guards, which is what makes
 * that ordering work.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildPinoConfig('api-gateway', config.get<string>('NODE_ENV', 'development')),
    }),
    /**
     * §16.2 use #1: Redis-backed storage, so the configured limit is the limit across
     * every gateway replica rather than N times too generous with N replicas.
     *
     * §10.2: two named buckets. 'strict' covers the unauthenticated write routes
     * (/auth/login, /auth/refresh, /onboarding/signup) — the only places an anonymous
     * caller can make the system do expensive work (an argon2 verify, a whole
     * onboarding saga). 'default' covers everything else. Each bucket uses skipIf to
     * apply to exactly its own routes, so the two never both count one request; the
     * route lists live in common/throttle-routes.ts, which explains why the
     * assignment is made here rather than with @Throttle() decorators.
     */
    ThrottlerModule.forRootAsync({
      inject: [ConfigService, REDIS_CLIENT],
      imports: [RedisModule],
      useFactory: (config: ConfigService, redis: Redis) => ({
        throttlers: [
          {
            name: 'default',
            ttl: Number(config.get('THROTTLE_TTL_MS', '60000')),
            limit: Number(config.get('THROTTLE_LIMIT', '100')),
            skipIf: (context: ExecutionContext) => {
              const url = context.switchToHttp().getRequest<Request>().originalUrl;
              return isStrictThrottlePath(url) || isUnthrottledPath(url);
            },
          },
          {
            name: 'strict',
            ttl: Number(config.get('THROTTLE_STRICT_TTL_MS', '60000')),
            limit: Number(config.get('THROTTLE_STRICT_LIMIT', '10')),
            skipIf: (context: ExecutionContext) =>
              !isStrictThrottlePath(context.switchToHttp().getRequest<Request>().originalUrl),
          },
        ],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    PassportModule,
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        timeout: Number(config.get('DOWNSTREAM_TIMEOUT_MS', '10000')),
        // Never follow a downstream redirect or throw on a 4xx before ProxyService
        // can normalise it — validateStatus stays default so axios throws and
        // ProxyService passes the real status through (§10.3).
        maxRedirects: 0,
      }),
    }),
    // Provides TenantContextStore, InternalContextSigner and InternalHttpClient.
    // InternalContextGuard is also exported by this module but is NOT registered as
    // a guard here — see the class doc above.
    TenantContextModule,
    RedisModule,
  ],
  controllers: [
    AuthController,
    OnboardingController,
    InvitationsController,
    OrganizationsController,
    UsersController,
    SubscriptionsController,
    ResourcesController,
    AuditController,
    DashboardController,
    HealthController,
  ],
  providers: [
    JwtStrategy,
    ProxyService,
    DownstreamConfig,
    PlatformAdminGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // §10.2/§26.2: accept the client's x-correlation-id or mint a UUIDv4. Must run
    // as middleware (i.e. before guards) so the id exists for every log line of the
    // request, including one rejected by JwtAuthGuard with a 401.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
