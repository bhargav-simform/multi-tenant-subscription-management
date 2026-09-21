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
import { AuditEvent } from './audit/audit-event.entity';
import { SecurityEvent } from './audit/security-event.entity';
import { AuditModule } from './audit/audit.module';
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
        buildPinoConfig('audit-service', config.get<string>('NODE_ENV', 'development')),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('POSTGRES_HOST'),
        port: Number(config.getOrThrow('POSTGRES_PORT')),
        username: config.getOrThrow<string>('APP_DB_USER'),
        password: config.getOrThrow<string>('APP_DB_PASSWORD'),
        database: config.getOrThrow<string>('AUDIT_DB_NAME'),
        // DELIBERATELY NO `schema` OPTION (§32.4). audit-service owns audit_db
        // outright (§14.1), exactly like auth-service, tenant-service and
        // resource-service, so its tables live in the default `public` schema
        // that Postgres's default search_path ("$user", public) already covers.
        // user-service's `schema: 'users'` and subscription-service's
        // `schema: 'subs'` exist ONLY because those two share one physical
        // core_db (§14.2) and their tables therefore live in schemas
        // search_path excludes. Setting one here would break resolution, not
        // protect it.
        entities: [AuditEvent, SecurityEvent],
        synchronize: false, // §15.1 — never true, would drop the RLS policies below
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
        serviceName: 'audit-service',
        // ONE group id for all five consumers (§17.2). They subscribe to five
        // DIFFERENT topics, so they do not compete for partitions with each
        // other — sharing the group means this service consumes each event once
        // and commits one set of offsets, which is also what makes the single
        // shared `consumed_events` table correct.
        groupId: 'audit-service-group',
      }),
    }),
    AuditModule,
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
