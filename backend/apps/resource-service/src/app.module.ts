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
import { Resource } from './resources/resource.entity';
import { PlanLimitCache } from './resources/plan-limit-cache.entity';
import { ResourcesModule } from './resources/resources.module';
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
        buildPinoConfig('resource-service', config.get<string>('NODE_ENV', 'development')),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('POSTGRES_HOST'),
        port: Number(config.getOrThrow('POSTGRES_PORT')),
        username: config.getOrThrow<string>('APP_DB_USER'),
        password: config.getOrThrow<string>('APP_DB_PASSWORD'),
        database: config.getOrThrow<string>('RESOURCE_DB_NAME'),
        // DELIBERATELY NO `schema` OPTION — and that is not an omission.
        // user-service sets `schema: 'users'` and subscription-service sets
        // `schema: 'subs'` ONLY because those two share one physical core_db
        // (§14.2) and their tables therefore live in custom schemas that
        // Postgres's default search_path ("$user", public) does not include.
        // resource-service owns resource_db outright (§14.1), so its tables
        // live in `public`, which search_path already covers — exactly like
        // auth-service and tenant-service, which own dedicated databases and
        // likewise set no `schema`. Setting one here would break resolution,
        // not protect it.
        entities: [Resource, PlanLimitCache],
        synchronize: false, // §15.1 — never true, would drop RLS policies
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
        serviceName: 'resource-service',
        groupId: 'resource-service-group',
      }),
    }),
    ResourcesModule,
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
