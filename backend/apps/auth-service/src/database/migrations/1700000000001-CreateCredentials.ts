import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * auth_db has NO Row-Level Security anywhere (§14.1, §8.2). It is a single-
 * service, single-tenant-scope-per-row database: a credential row is always
 * looked up by email (login) or userId (internal), never listed per
 * organisation, so there is no cross-tenant query surface for RLS to guard
 * against. Both tables are registered in REGISTRY_TABLES (see
 * libs/database/src/entities/table-registry.ts), alongside organizations and
 * onboarding_sagas from tenant-service — a distinct justification within the
 * same category, documented there.
 */
export class CreateCredentials1700000000001 implements MigrationInterface {
  name = 'CreateCredentials1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS citext`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await queryRunner.query(`
      CREATE TYPE "credentials_status_enum" AS ENUM ('active', 'disabled')
    `);

    await queryRunner.query(`
      CREATE TABLE "credentials" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "organization_id" uuid,
        "email" citext NOT NULL,
        "password_hash" text NOT NULL,
        "status" "credentials_status_enum" NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_credentials_email" UNIQUE ("email")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_credentials_user_id" ON "credentials" ("user_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "credential_id" uuid NOT NULL REFERENCES "credentials"("id") ON DELETE CASCADE,
        "token_hash" varchar(64) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz,
        "replaced_by" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_refresh_tokens_token_hash" UNIQUE ("token_hash")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_refresh_tokens_credential_id" ON "refresh_tokens" ("credential_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "credentials"`);
    await queryRunner.query(`DROP TYPE "credentials_status_enum"`);
  }
}
