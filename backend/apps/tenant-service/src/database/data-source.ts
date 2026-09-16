import { DataSource } from 'typeorm';
import { CreateOrganizationsAndSagas1700000000001 } from './migrations/1700000000001-CreateOrganizationsAndSagas';

/**
 * §27.3 / §22.1: the CLI-runnable DataSource the one-shot `migrator` container
 * uses. TypeORM 1.1.x's CLI takes `-d <path-to-this-file>` and reads the
 * DEFAULT export, so this file exports the DataSource itself, not a factory.
 *
 * Two things differ deliberately from the runtime DataSource in app.module.ts:
 *
 *  1. It connects as MIGRATOR_DB_USER (`app_migrator`), not APP_DB_USER.
 *     Migrations issue DDL — CREATE TABLE, CREATE POLICY, CREATE FUNCTION,
 *     GRANT — and app_user has none of those rights by design (§13.5). This is
 *     also why NO service runs its own migrations at boot: migrationsRun stays
 *     false everywhere, because a running service never holds a credential that
 *     could execute one.
 *
 *  2. `entities` is deliberately EMPTY. Migrations are raw SQL against a
 *     QueryRunner; loading entities here would serve only to tempt someone into
 *     `synchronize`, which §15.1 forbids outright (it would drop RLS policies).
 *
 * Migrations are listed as explicit imported classes rather than a glob. A glob
 * resolves differently under ts-node (`.ts`) and in the compiled container
 * (`.js` under dist/apps/<svc>/apps/<svc>/src/...), and silently matching
 * nothing is the failure mode that lets a migrator container exit 0 having done
 * nothing at all.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? '5432'),
  username: process.env.MIGRATOR_DB_USER ?? 'app_migrator',
  password: process.env.MIGRATOR_DB_PASSWORD,
  database: process.env.TENANT_DB_NAME ?? 'tenant_db',
  entities: [],
  migrations: [CreateOrganizationsAndSagas1700000000001],
  migrationsTableName: 'tenant_service_migrations',
  synchronize: false,
  logging: ['error', 'warn', 'migration'],
});
