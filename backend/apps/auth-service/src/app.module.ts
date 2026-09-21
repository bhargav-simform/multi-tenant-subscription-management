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
import { Credential } from './credentials/credential.entity';
import { RefreshToken } from './credentials/refresh-token.entity';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health.controller';

/**
 * Request lifecycle matches every other service (§13.2, §8.2) — see
 * tenant-service's AppModule for the full breakdown: TenantContextMiddleware
 * verifies + opens the ALS scope, then InternalContextGuard (defense in
 * depth) and CaslAbilityGuard run against it. auth-service's own routes carry
 * no @CheckAbility() — login/refresh/logout have no role-based distinction
 * (anyone with valid credentials may use them), and /internal/auth/credentials
 * is reachable by any service that can produce a valid signed context, which
 * in practice is only tenant-service (network isolation, §10.5).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildPinoConfig('auth-service', config.get<string>('NODE_ENV', 'development')),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('POSTGRES_HOST'),
        port: Number(config.getOrThrow('POSTGRES_PORT')),
        username: config.getOrThrow<string>('APP_DB_USER'),
        password: config.getOrThrow<string>('APP_DB_PASSWORD'),
        database: config.getOrThrow<string>('AUTH_DB_NAME'),
        entities: [Credential, RefreshToken],
        synchronize: false, // §15.1 — never true, would drop RLS policies elsewhere
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
        serviceName: 'auth-service',
        groupId: 'auth-service-group',
      }),
    }),
    AuthModule,
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
