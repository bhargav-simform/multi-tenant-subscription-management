import { DataSource } from 'typeorm';
import { CreateAuditAndSecurityEvents1700000000001 } from './migrations/1700000000001-CreateAuditAndSecurityEvents';
import { CreateConsumedEvents1700000000002 } from './migrations/1700000000002-CreateConsumedEvents';

/** §27.3 / §22.1 — see apps/tenant-service/src/database/data-source.ts for the
 * full rationale. audit_db is owned outright by this service (§8.7,
 * append-only: app_user gets SELECT+INSERT and never UPDATE/DELETE, granted by
 * docker/postgres/init.sh — nothing here changes that). */
export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? '5432'),
  username: process.env.MIGRATOR_DB_USER ?? 'app_migrator',
  password: process.env.MIGRATOR_DB_PASSWORD,
  database: process.env.AUDIT_DB_NAME ?? 'audit_db',
  entities: [],
  migrations: [
    CreateAuditAndSecurityEvents1700000000001,
    CreateConsumedEvents1700000000002,
  ],
  migrationsTableName: 'audit_service_migrations',
  synchronize: false,
  logging: ['error', 'warn', 'migration'],
});
