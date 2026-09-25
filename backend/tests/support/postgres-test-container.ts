import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { PrismaClient } from '../../src/generated/prisma/client';
import { setPrisma } from '../../src/lib/prisma';

const APP_PASSWORD = 'test-app-password';
const MIGRATOR_PASSWORD = 'test-migrator-password';
const MIGRATION_SQL = join(__dirname, '../../prisma/migrations/0001_init/migration.sql');

/**
 * A real PostgreSQL 17 with the production role layout (app_migrator / app_user /
 * app_rls_bypass, same attributes as docker/postgres/init.sh) and the real
 * migration applied. The app's Prisma singleton is pointed at it as app_user, so
 * services under test go through RLS exactly as in production.
 */
export class PostgresTestContainer {
  private container!: StartedPostgreSqlContainer;
  prisma!: PrismaClient;
  appUrl!: string;
  migratorUrl!: string;
  superuserUrl!: string;

  async start(): Promise<void> {
    this.container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('test_db')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();

    this.superuserUrl = this.container.getConnectionUri();
    await this.withClient(this.superuserUrl, async (admin) => {
      await admin.query(
        `CREATE ROLE app_migrator WITH LOGIN PASSWORD '${MIGRATOR_PASSWORD}' NOSUPERUSER NOBYPASSRLS CREATEDB`,
      );
      await admin.query(
        `CREATE ROLE app_user WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`,
      );
      await admin.query(`CREATE ROLE app_rls_bypass WITH NOLOGIN NOSUPERUSER BYPASSRLS`);
      await admin.query(`GRANT app_rls_bypass TO app_migrator`);
      await admin.query(`GRANT CREATE ON DATABASE test_db TO app_migrator`);
      await admin.query(`GRANT ALL ON SCHEMA public TO app_migrator`);
      await admin.query(`GRANT ALL ON SCHEMA public TO app_rls_bypass`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO app_user`);
      await admin.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    });

    this.migratorUrl = withCredentials(this.superuserUrl, 'app_migrator', MIGRATOR_PASSWORD);
    this.appUrl = withCredentials(this.superuserUrl, 'app_user', APP_PASSWORD);

    // The migration file is plain SQL (DO blocks included); run it as the migrator,
    // exactly as `prisma migrate deploy` does in the migrator container.
    await this.withClient(this.migratorUrl, (c) => c.query(readFileSync(MIGRATION_SQL, 'utf8')));

    this.prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: this.appUrl }) });
    setPrisma(this.prisma);
  }

  /** Run raw SQL as app_user, outside the app's helpers (e.g. a "careless" query). */
  async asAppUser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    return this.withClient(this.appUrl, fn);
  }

  /** Run raw SQL as app_migrator (the table owner) — for seeding fixtures past RLS/grants. */
  async asMigrator<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    return this.withClient(this.migratorUrl, fn);
  }

  /** Run raw SQL as the superuser — for fixtures that must bypass RLS entirely. */
  async asSuperuser<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    return this.withClient(this.superuserUrl, fn);
  }

  async stop(): Promise<void> {
    setPrisma(undefined);
    await this.prisma?.$disconnect();
    await this.container?.stop();
  }

  private async withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
}

function withCredentials(uri: string, user: string, password: string): string {
  const url = new URL(uri);
  url.username = user;
  url.password = password;
  return url.toString();
}
