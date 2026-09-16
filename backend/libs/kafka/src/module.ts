import { DynamicModule, Global, Module, type InjectionToken } from '@nestjs/common';
import { EventPublisher } from './producer/event-publisher';
import { KAFKA_CLIENT, type KafkaModuleOptions } from './kafka.options';

/**
 * §20: provides EventPublisher and the KAFKA_CLIENT token every
 * BaseKafkaConsumer subclass also injects.
 *
 * §32.4: this used to be a plain static module, with each service's AppModule
 * declaring `{ provide: KAFKA_CLIENT, ... }` as a SIBLING provider alongside
 * `KafkaModule` in its own `imports`/`providers` arrays. That does not work in
 * Nest: a provider declared in AppModule's own `providers` lives in
 * AppModule's injector scope, and a separately-imported module (KafkaModule)
 * cannot see it — `@Global()` only broadens what a module'S OWN exports reach,
 * not what it can see of a sibling's providers. This went undetected because
 * no test ever loads KafkaModule through Nest's DI container; it surfaced
 * only when a real container tried to boot ("Nest can't resolve dependencies
 * of the EventPublisher (?, TenantContextStore)"). Fixed by making this a
 * `forRootAsync`-style dynamic module, exactly like `TypeOrmModule` — each
 * service now passes its `KafkaModuleOptions` factory INTO `KafkaModule`
 * itself, so `KAFKA_CLIENT` is a real provider inside this module's own
 * scope, not a sibling one it could never see.
 */
@Global()
@Module({})
export class KafkaModule {
  static forRootAsync(options: {
    inject: InjectionToken[];
    useFactory: (...args: never[]) => KafkaModuleOptions;
  }): DynamicModule {
    return {
      module: KafkaModule,
      providers: [
        {
          provide: KAFKA_CLIENT,
          inject: options.inject,
          useFactory: options.useFactory,
        },
        EventPublisher,
      ],
      exports: [KAFKA_CLIENT, EventPublisher],
    };
  }
}
