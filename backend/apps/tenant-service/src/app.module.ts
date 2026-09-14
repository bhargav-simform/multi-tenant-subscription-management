import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantContextModule, TenantContextMiddleware, InternalContextGuard } from '@app/tenant-context';
import { AuthorizationModule, CaslAbilityGuard } from '@app/authorization';
import { DatabaseModule } from '@app/database';
import { RedisModule } from '@app/redis';
import { KAFKA_CLIENT, KafkaModule } from '@app/kafka';
import { OrganizationsModule } from './organizations/organizations.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { buildPinoConfig } from '@app/logging';
import { Organization } from './organizations/organization.entity';
import { OnboardingSaga } from './onboarding/onboarding-saga.entity';
import { HealthController } from './health.controller';

/**
 * Guard order (§8.2 request lifecycle, §13.2):
 *   1. InternalContextGuard  — verifies the signed header, rejects 401
 *   2. TenantContextMiddleware (registered below) — opens the ALS scope
 *   3. CaslAbilityGuard      — the real authorization decision (§12.5)
 * ValidationPipe runs as part of Nest's own pipeline before the handler body.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildPinoConfig('tenant-service', config.get('NODE_ENV', 'development')),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('POSTGRES_HOST'),
        port: Number(config.get('POSTGRES_PORT', '5432')),
        username: config.getOrThrow<string>('APP_DB_USER'),
        password: config.getOrThrow<string>('APP_DB_PASSWORD'),
        database: config.getOrThrow<string>('TENANT_DB_NAME'),
        entities: [Organization, OnboardingSaga],
        synchronize: false, // §15.1 — never true, would drop RLS policies elsewhere
        migrationsRun: false,
      }),
    }),
    TenantContextModule,
    AuthorizationModule,
    DatabaseModule,
    RedisModule,
    KafkaModule,
    OrganizationsModule,
    OnboardingModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: InternalContextGuard },
    { provide: APP_GUARD, useClass: CaslAbilityGuard },
    {
      provide: KAFKA_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        clientIdPrefix: config.get<string>('KAFKA_CLIENT_ID_PREFIX', 'mtsm'),
        serviceName: 'tenant-service',
        groupId: 'tenant-service-group',
      }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
