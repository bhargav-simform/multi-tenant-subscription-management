import { DataSource } from 'typeorm';
import { CreatePlansAndExtendSubscriptions1700000000001 } from './migrations/1700000000001-CreatePlansAndExtendSubscriptions';
import { CreateConsumedEvents1700000000002 } from './migrations/1700000000002-CreateConsumedEvents';
import { FixRlsPolicyNullifEmptyString1700000000003 } from './migrations/1700000000003-FixRlsPolicyNullifEmptyString';
import { FixSecurityDefinerOwnerForForceRls1700000000004 } from './migrations/1700000000004-FixSecurityDefinerOwnerForForceRls';

/**
 * §27.3 / §22.1 — see apps/tenant-service/src/database/data-source.ts for the
 * full rationale, and apps/user-service/src/database/data-source.ts for why
 * `migrationsTableName` is per-service rather than TypeORM's shared default
 * (both services target core_db, and both declare a class named
 * `CreateConsumedEvents1700000000002` — a shared ledger would silently skip
 * this one).
 *
 * §32.3: these migrations ALTER a subs.subscriptions that user-service's
 * migration must already have created. The migrator script sequences that.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? '5432'),
  username: process.env.MIGRATOR_DB_USER ?? 'app_migrator',
  password: process.env.MIGRATOR_DB_PASSWORD,
  database: process.env.CORE_DB_NAME ?? 'core_db',
  entities: [],
  migrations: [
    CreatePlansAndExtendSubscriptions1700000000001,
    CreateConsumedEvents1700000000002,
    FixRlsPolicyNullifEmptyString1700000000003,
    FixSecurityDefinerOwnerForForceRls1700000000004,
  ],
  // See user-service's data-source.ts: core_db's `public` schema is not
  // writable by app_migrator (init.sh revokes CREATE there and never grants it
  // back), so the migrations ledger must live in this service's own schema.
  schema: 'subs',
  migrationsTableName: 'subscription_service_migrations',
  synchronize: false,
  logging: ['error', 'warn', 'migration'],
});
