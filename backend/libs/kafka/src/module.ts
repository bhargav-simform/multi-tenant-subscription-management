import { Global, Module } from '@nestjs/common';
import { EventPublisher } from './producer/event-publisher';

/**
 * §20: provides EventPublisher, which depends on KAFKA_CLIENT. Each service's
 * AppModule provides KAFKA_CLIENT (its own broker config, service name, group
 * id — §17.2) BEFORE importing this module, since EventPublisher's constructor
 * injects KAFKA_CLIENT directly.
 */
@Global()
@Module({
  providers: [EventPublisher],
  exports: [EventPublisher],
})
export class KafkaModule {}
