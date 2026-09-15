import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { DataSource, type EntitySchema } from 'typeorm';

// TypeORM's own EntityTarget<any> shape; a test helper accepting "any entity
// class" has no narrower honest type than the library it wraps uses for the
// same purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EntityTarget = (new (...args: any[]) => object) | EntitySchema | string;

const APP_PASSWORD = 'test-app-password';
const MIGRATOR_PASSWORD = 'test-migrator-password';

/**
 * §28.1: "RLS policies and row locks cannot be mocked — they need a real
 * PostgreSQL." This helper stands up a single throwaway Postgres container
 * per test file, creates the SAME two roles docker/postgres/init.sh creates
 * in the real deployment (app_migrator: DDL, app_user: DML-only,
 * NOSUPERUSER, NOBYPASSRLS), and exposes a DataSource connected as app_user
 * — the same role every service actually runs as — so a test using this
 * helper is exercising the real isolation and locking mechanisms, not a
 * stand-in for them.
 */
export class PostgresTestContainer {
  private container!: StartedPostgreSqlContainer;
  private migratorDataSource!: DataSource;
  appDataSource!: DataSource;

  async start(entities: EntityTarget[] = [], schema?: string): Promise<void> {
    this.container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('test_db')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();

    // Mirrors docker/postgres/init.sh's role creation (§13.5, §22.1) —
    // app_user is NOSUPERUSER/NOBYPASSRLS, the property the whole RLS
    // guarantee depends on and that assertRlsSafeRole checks at boot.
    const admin = new Client({ connectionString: this.container.getConnectionUri() });
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE app_migrator WITH LOGIN PASSWORD '${MIGRATOR_PASSWORD}' NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE`,
      );
      await admin.query(
        `CREATE ROLE app_user WITH LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`,
      );
      await admin.query(`GRANT ALL ON SCHEMA public TO app_migrator`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO app_user`);
      await admin.query(`ALTER DATABASE test_db OWNER TO app_migrator`);
    } finally {
      await admin.end();
    }

    const migratorUri = this.replaceCredentials(
      this.container.getConnectionUri(),
      'app_migrator',
      MIGRATOR_PASSWORD,
    );
    this.migratorDataSource = new DataSource({
      type: 'postgres',
      url: migratorUri,
      synchronize: false,
    });
    await this.migratorDataSource.initialize();

    const appUri = this.replaceCredentials(
      this.container.getConnectionUri(),
      'app_user',
      APP_PASSWORD,
    );
    this.appDataSource = new DataSource({
      type: 'postgres',
      url: appUri,
      synchronize: false,
      // Mirrors each service's real app.module.ts: Postgres's default
      // search_path ("$user", public) does not include custom schemas, so a
      // caller exercising bare-named entities (User, Invitation, ...) must
      // pass the same `schema` its production DataSource sets, or the
      // resolution bug that setting fixes would go uncaught here too.
      schema,
      entities,
    });
  }

  /** Runs a migration's up() as app_migrator — the same role that owns tables in production. */
  async runMigration(up: (queryRunner: import('typeorm').QueryRunner) => Promise<void>): Promise<void> {
    const queryRunner = this.migratorDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await up(queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  /** Grants default privileges so app_user can use tables app_migrator creates — mirrors init.sh. */
  async grantAppUserAccessToSchema(schema: string): Promise<void> {
    const queryRunner = this.migratorDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query(`GRANT USAGE ON SCHEMA "${schema}" TO app_user`);
      await queryRunner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO app_user`,
      );
      await queryRunner.query(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO app_user`,
      );
    } finally {
      await queryRunner.release();
    }
  }

  async connectAppDataSource(): Promise<void> {
    if (!this.appDataSource.isInitialized) {
      await this.appDataSource.initialize();
    }
  }

  async stop(): Promise<void> {
    if (this.appDataSource?.isInitialized) await this.appDataSource.destroy();
    if (this.migratorDataSource?.isInitialized) await this.migratorDataSource.destroy();
    await this.container?.stop();
  }

  private replaceCredentials(uri: string, user: string, password: string): string {
    const url = new URL(uri);
    url.username = user;
    url.password = password;
    return url.toString();
  }
}
