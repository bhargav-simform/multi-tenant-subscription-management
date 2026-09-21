import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import {
  TenantContextModule,
  TenantContextMiddleware,
  InternalContextGuard,
} from '@app/tenant-context';
import { AuthorizationModule, CaslAbilityGuard } from '@app/authorization';
import { DatabaseModule } from '@app/database';
import { RedisModule } from '@app/redis';
import { KafkaModule } from '@app/kafka';
import { buildPinoConfig } from '@app/logging';
import { Plan } from './plans/plan.entity';
import { Subscription } from './subscriptions/subscription.entity';
import { SubscriptionHistory } from './subscriptions/subscription-history.entity';
import { PlansModule } from './plans/plans.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { UsageModule } from './usage/usage.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';

/**
 * Request lifecycle matches every other service (§13.2) — see tenant-service's
 * AppModule for the full breakdown: TenantContextMiddleware verifies + opens
 * the ALS scope, then InternalContextGuard (defense in depth) and
 * CaslAbilityGuard run against it.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildPinoConfig('subscription-service', config.get<string>('NODE_ENV', 'development')),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('POSTGRES_HOST'),
        port: Number(config.getOrThrow('POSTGRES_PORT')),
        username: config.getOrThrow<string>('APP_DB_USER'),
        password: config.getOrThrow<string>('APP_DB_PASSWORD'),
        database: config.getOrThrow<string>('CORE_DB_NAME'),
        // Postgres's default search_path ("$user", public) does NOT include
        // custom schemas — bare @Entity() names would fail to resolve
        // against subs.* without this (empirically verified against a real
        // Postgres container). §14.2: Subscription here maps the FULL table
        // (this service's own view), distinct from user-service's narrow
        // SubscriptionSeatView into the same physical row.
        schema: 'subs',
        entities: [Plan, Subscription, SubscriptionHistory],
        synchronize: false,
        migrationsRun: false,
      }),
    }),
    TenantContextModule,
    AuthorizationModule,
    DatabaseModule,
    RedisModule,
    KafkaModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        clientIdPrefix: config.get<string>('KAFKA_CLIENT_ID_PREFIX', 'mtsm'),
        serviceName: 'subscription-service',
        groupId: 'subscription-service-group',
      }),
    }),
    PlansModule,
    SubscriptionsModule,
    UsageModule,
    EventsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: InternalContextGuard },
    { provide: APP_GUARD, useClass: CaslAbilityGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
