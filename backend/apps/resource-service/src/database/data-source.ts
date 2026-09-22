import { DataSource } from 'typeorm';
import { CreateResourcesAndPlanLimitCache1700000000001 } from './migrations/1700000000001-CreateResourcesAndPlanLimitCache';
import { CreateConsumedEvents1700000000002 } from './migrations/1700000000002-CreateConsumedEvents';
import { AddResourceSizeIndex1700000000003 } from './migrations/1700000000003-AddResourceSizeIndex';

/** §27.3 / §22.1 — see apps/tenant-service/src/database/data-source.ts for the
 * full rationale. resource_db is owned outright by this service, so its
 * migrations ledger cannot collide with another's; the table is still named
 * explicitly for symmetry with core_db's two tenants. */
export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? '5432'),
  username: process.env.MIGRATOR_DB_USER ?? 'app_migrator',
  password: process.env.MIGRATOR_DB_PASSWORD,
  database: process.env.RESOURCE_DB_NAME ?? 'resource_db',
  entities: [],
  migrations: [
    CreateResourcesAndPlanLimitCache1700000000001,
    CreateConsumedEvents1700000000002,
    AddResourceSizeIndex1700000000003,
  ],
  migrationsTableName: 'resource_service_migrations',
  synchronize: false,
  logging: ['error', 'warn', 'migration'],
});
