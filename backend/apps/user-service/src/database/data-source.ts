import { DataSource } from 'typeorm';
import { CreateUsersAndInvitations1700000000001 } from './migrations/1700000000001-CreateUsersAndInvitations';
import { CreateConsumedEvents1700000000002 } from './migrations/1700000000002-CreateConsumedEvents';
import { FixRlsPolicyNullifEmptyString1700000000003 } from './migrations/1700000000003-FixRlsPolicyNullifEmptyString';
import { AddUserExistsFunction1700000000004 } from './migrations/1700000000004-AddUserExistsFunction';
import { AddInvitationOrganizationIdFunction1700000000005 } from './migrations/1700000000005-AddInvitationOrganizationIdFunction';

/**
 * §27.3 / §22.1 — see apps/tenant-service/src/database/data-source.ts for the
 * full rationale (app_migrator not app_user; empty entities; explicit migration
 * classes rather than a glob).
 *
 * TWO THINGS ARE LOAD-BEARING HERE AND NOWHERE ELSE, both consequences of
 * §14.2's shared core_db:
 *
 *  1. `migrationsTableName` is per-service, NOT TypeORM's default `migrations`.
 *     user-service and subscription-service run against the SAME physical
 *     database. With one shared bookkeeping table they would read each other's
 *     rows; worse, both services have a migration class literally named
 *     `CreateConsumedEvents1700000000002`, and TypeORM keys that table on
 *     (timestamp, name) — so subscription-service's would be seen as ALREADY
 *     RUN and silently skipped, leaving subs.consumed_events uncreated and the
 *     migrator exiting 0. Separate tables make the two ledgers independent.
 *
 *  2. §32.3 sequencing: this service's migrations MUST complete before
 *     subscription-service's. CreateUsersAndInvitations creates a minimal
 *     subs.subscriptions that CreatePlansAndExtendSubscriptions then ALTERs.
 *     That order is enforced by docker/migrator/run-migrations.sh, not here —
 *     nothing in a DataSource can express a cross-service dependency.
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
    CreateUsersAndInvitations1700000000001,
    CreateConsumedEvents1700000000002,
    FixRlsPolicyNullifEmptyString1700000000003,
    AddUserExistsFunction1700000000004,
    AddInvitationOrganizationIdFunction1700000000005,
  ],
  // The migrations ledger lives in THIS SERVICE'S OWN SCHEMA, not `public`.
  // Two reasons, the second discovered empirically:
  //
  //  a. It keeps core_db's two tenants' bookkeeping as separated as their
  //     tables already are.
  //  b. core_db's `public` schema is not writable by app_migrator at all.
  //     docker/postgres/init.sh deliberately REVOKEs CREATE on core_db's
  //     public schema from PUBLIC and — unlike the single-owner databases,
  //     which go through grant_standard_schema() — never grants it back,
  //     because nothing is supposed to live there. Leaving the ledger at
  //     TypeORM's default therefore fails with `permission denied for schema
  //     public` before the first migration even starts. Putting it in `users`
  //     (created AUTHORIZATION app_migrator by init.sh) is the fix that does
  //     NOT require widening any grant.
  schema: 'users',
  migrationsTableName: 'user_service_migrations',
  synchronize: false,
  logging: ['error', 'warn', 'migration'],
});
