import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContextModule } from '@app/tenant-context';
import { TenantAwareDataSource } from './data-source/tenant-aware-data-source';

/**
 * Provides TenantAwareDataSource. Each service's AppModule imports TypeOrmModule
 * separately (its own DataSource, its own entities, its own migrations — §15.1),
 * then imports this module to get the tenant-scoping wrapper around it.
 */
@Module({
  imports: [TenantContextModule],
  providers: [TenantAwareDataSource, { provide: DataSource, useExisting: DataSource }],
  exports: [TenantAwareDataSource],
})
export class DatabaseModule {}
