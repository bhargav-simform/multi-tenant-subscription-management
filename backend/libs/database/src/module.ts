import { Global, Module } from '@nestjs/common';
import { TenantContextModule } from '@app/tenant-context';
import { TenantAwareDataSource } from './data-source/tenant-aware-data-source';

/**
 * Provides TenantAwareDataSource. Each service's AppModule imports TypeOrmModule
 * separately (its own DataSource, its own entities, its own migrations — §15.1),
 * then imports this module to get the tenant-scoping wrapper around it.
 *
 * §32.4: this module used to also declare
 * `{ provide: DataSource, useExisting: DataSource }` — a self-referential
 * provider that shadowed the real one instead of resolving to it, since this
 * module never imports TypeOrmModule itself. It went undetected because no
 * test ever loads this module through Nest's DI container (integration tests
 * construct `new TenantAwareDataSource(...)` by hand); it surfaced only when
 * a real container tried to boot: "Nest can't resolve dependencies of the
 * DataSource (?)". The fix is to remove that line entirely — TypeORM's
 * `TypeOrmCoreModule` (created by `TypeOrmModule.forRootAsync` in every
 * service's AppModule) is itself `@Global()` (confirmed by reading its
 * source), so the real `DataSource` it provides is already visible to
 * `TenantAwareDataSource`'s constructor injection everywhere in the app,
 * with nothing to re-declare here.
 *
 * §32.4: also marked `@Global()` now, for the identical reason
 * `TenantContextModule` and `KafkaModule` already are. Without it, a feature
 * module several levels deep (e.g. user-service's `EventsModule`, which never
 * imports `DatabaseModule` itself) cannot see `TenantAwareDataSource` at
 * all — Nest's DI scoping is per-module, not transitively visible through
 * AppModule just because both are imported there. This was the second of two
 * real DI defects found only when a real container tried to boot every
 * service (no test loads consumers or repositories through Nest's container;
 * they are constructed by hand in every existing test).
 */
@Global()
@Module({
  imports: [TenantContextModule],
  providers: [TenantAwareDataSource],
  exports: [TenantAwareDataSource],
})
export class DatabaseModule {}
