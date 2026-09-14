import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * organizations and onboarding_sagas are DELIBERATELY NOT RLS-protected (§8.3).
 * They are the tenant registry itself, not tenant content — a platform admin
 * reads this table directly for the org list (§13.6), and RLS would prevent
 * that legitimate read. Both tables are registered in REGISTRY_TABLES, a
 * distinct category from GLOBAL_TABLES and TENANT_TABLES (see
 * libs/database/src/entities/table-registry.ts), so the §13.8 CI check does
 * not flag their absence of a policy as a violation.
 *
 * No other table in this service holds organisation CONTENT — that boundary is
 * what makes "platform admin sees orgs but not content" true by construction.
 */
export class CreateOrganizationsAndSagas1700000000001 implements MigrationInterface {
  name = 'CreateOrganizationsAndSagas1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "organizations_status_enum" AS ENUM (
        'provisioning', 'active', 'provisioning_failed', 'suspended'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(255) NOT NULL,
        "slug" varchar(255) NOT NULL,
        "status" "organizations_status_enum" NOT NULL DEFAULT 'provisioning',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_organizations_slug" UNIQUE ("slug")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_organizations_created_at" ON "organizations" ("created_at" DESC, "id")
    `);

    await queryRunner.query(`
      CREATE TYPE "onboarding_sagas_state_enum" AS ENUM (
        'pending', 'org_created', 'credentials_created', 'subscribed', 'complete'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "onboarding_sagas" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "idempotency_key" varchar(255) NOT NULL,
        "organization_id" uuid,
        "state" "onboarding_sagas_state_enum" NOT NULL DEFAULT 'pending',
        "admin_email" varchar(255) NOT NULL,
        "last_error" text,
        "failed_at" timestamptz,
        "attempts" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_onboarding_sagas_idempotency_key" UNIQUE ("idempotency_key")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_onboarding_sagas_org" ON "onboarding_sagas" ("organization_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "onboarding_sagas"`);
    await queryRunner.query(`DROP TYPE "onboarding_sagas_state_enum"`);
    await queryRunner.query(`DROP TABLE "organizations"`);
    await queryRunner.query(`DROP TYPE "organizations_status_enum"`);
  }
}
