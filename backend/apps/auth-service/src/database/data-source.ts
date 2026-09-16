import { DataSource } from 'typeorm';
import { CreateCredentials1700000000001 } from './migrations/1700000000001-CreateCredentials';

/** §27.3 / §22.1 — see apps/tenant-service/src/database/data-source.ts for the
 * full rationale (app_migrator not app_user; empty entities; explicit migration
 * classes rather than a glob). auth_db is owned outright by this service. */
export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? '5432'),
  username: process.env.MIGRATOR_DB_USER ?? 'app_migrator',
  password: process.env.MIGRATOR_DB_PASSWORD,
  database: process.env.AUTH_DB_NAME ?? 'auth_db',
  entities: [],
  migrations: [CreateCredentials1700000000001],
  migrationsTableName: 'auth_service_migrations',
  synchronize: false,
  logging: ['error', 'warn', 'migration'],
});
