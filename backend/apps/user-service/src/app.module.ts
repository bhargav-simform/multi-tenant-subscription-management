import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import {
  TenantContextModule,
  TenantContextMiddleware,
  InternalContextGuard,
} from '@app/tenant-context';
import { AuthorizationModule, CaslAbilityGuard } from '@app/authorization';
import { DatabaseModule } from '@app/database';
import { RedisModule } from '@app/redis';
import { KAFKA_CLIENT, KafkaModule } from '@app/kafka';
import { buildPinoConfig } from '@app/logging';
import { User } from './users/user.entity';
import { Invitation } from './invitations/invitation.entity';
import { SubscriptionSeatView } from './subscriptions/subscription.entity';
import { UsersModule } from './users/users.module';
import { InvitationsModule } from './invitations/invitations.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { EventsModule } from './events/events.module';
import { InvitationExpirySweepService } from './sweep/invitation-expiry-sweep.service';
import { HealthController } from './health.controller';

/**
 * Guard order matches every other service (§13.2, §19.2): InternalContextGuard
 * first, then CaslAbilityGuard. ScheduleModule enables the §19.9 sweep's
 * @Cron decorator — the only background job in the system.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildPinoConfig('user-service', config.get<string>('NODE_ENV', 'development')),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('POSTGRES_HOST'),
        port: Number(config.get('POSTGRES_PORT', '5432')),
        username: config.getOrThrow<string>('APP_DB_USER'),
        password: config.getOrThrow<string>('APP_DB_PASSWORD'),
        database: config.getOrThrow<string>('CORE_DB_NAME'),
        // §14.2: user-service's DataSource spans BOTH schemas it touches —
        // its own (users) and the one narrow view into subs it is granted
        // (SubscriptionSeatView, SELECT/UPDATE on subs.subscriptions only).
        entities: [User, Invitation, SubscriptionSeatView],
        synchronize: false, // §15.1 — never true, would drop RLS policies elsewhere
        migrationsRun: false,
      }),
    }),
    TenantContextModule,
    AuthorizationModule,
    DatabaseModule,
    RedisModule,
    KafkaModule,
    UsersModule,
    InvitationsModule,
    SubscriptionsModule,
    EventsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: InternalContextGuard },
    { provide: APP_GUARD, useClass: CaslAbilityGuard },
    InvitationExpirySweepService,
    {
      provide: KAFKA_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        brokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        clientIdPrefix: config.get<string>('KAFKA_CLIENT_ID_PREFIX', 'mtsm'),
        serviceName: 'user-service',
        groupId: 'user-service-group',
      }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
