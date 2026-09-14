import { MigrationInterface, QueryRunner } from 'typeorm';
import { enableTenantRls } from '@app/database';

/**
 * §14.2: user-service and subscription-service share ONE physical database
 * (core_db), in separate schemas (`users`, `subs`). This migration creates
 * BOTH schemas and BOTH tenant tables user-service needs (users, invitations,
 * fully RLS-protected), plus a MINIMAL subs.subscriptions — only the columns
 * the §19 seat lock needs — because subscription-service does not exist yet.
 *
 * §32.3 "Migration sequencing for core_db": subscription-service's own
 * migration will later ALTER TABLE subs.subscriptions to add its remaining
 * columns (plan_id, status, used_storage_bytes, etc.) — never drop/recreate
 * this table. Two services migrating one physical table is unusual; it is
 * the direct consequence of §14.2's shared-database decision.
 */
export class CreateUsersAndInvitations1700000000001 implements MigrationInterface {
  name = 'CreateUsersAndInvitations1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS citext`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS users`);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS subs`);

    // ── users.users (§8.4, RLS: yes) ────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE "users"."users_role_enum" AS ENUM ('org_admin', 'org_member')
    `);
    await queryRunner.query(`
      CREATE TYPE "users"."users_status_enum" AS ENUM ('active', 'removed')
    `);
    await queryRunner.query(`
      CREATE TABLE "users"."users" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "email" citext NOT NULL,
        "first_name" varchar(255) NOT NULL,
        "last_name" varchar(255) NOT NULL,
        "role" "users"."users_role_enum" NOT NULL,
        "status" "users"."users_status_enum" NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "uq_users_org_email" UNIQUE ("organization_id", "email")
      )
    `);
    await enableTenantRls(queryRunner, 'users.users');
    await queryRunner.query(`
      CREATE INDEX "idx_users_org_created" ON "users"."users" ("organization_id", "created_at" DESC, "id")
    `);

    // ── users.invitations (§8.4, RLS: yes) ──────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "users"."invitations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "email" citext NOT NULL,
        "role" "users"."users_role_enum" NOT NULL,
        "token_hash" varchar(64) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "accepted_at" timestamptz,
        "revoked_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "deleted_at" timestamptz,
        CONSTRAINT "uq_invitations_token_hash" UNIQUE ("token_hash")
      )
    `);
    await enableTenantRls(queryRunner, 'users.invitations');
    await queryRunner.query(`
      CREATE INDEX "idx_invitations_org_status"
        ON "users"."invitations" ("organization_id", "accepted_at", "expires_at")
    `);
    // §19.7: a second pending invite to the same email cannot hold a second
    // seat for one person. Partial unique index — only applies while pending.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_invitations_org_email_pending"
        ON "users"."invitations" ("organization_id", "email")
        WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL
    `);

    // ── subs.subscriptions (MINIMAL — §32.3 sequencing note above) ──────
    // RLS is applied even though this migration only shapes a subset of the
    // table's eventual columns — the table is [RLS] in §14.3's full schema
    // sketch, and it exists as soon as this migration runs, so leaving it
    // unprotected in the interim would be a real, if temporary, gap (§13.7
    // row 3's exact mistake). subscription-service's later ALTER TABLE adds
    // columns to an already-RLS-protected table; it must not touch the policy.
    await queryRunner.query(`
      CREATE TABLE "subs"."subscriptions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" uuid NOT NULL,
        "used_seats" int NOT NULL DEFAULT 0,
        "max_seats_snapshot" int NOT NULL,
        CONSTRAINT "uq_subscriptions_org" UNIQUE ("organization_id"),
        CONSTRAINT "ck_subscriptions_seats" CHECK ("used_seats" <= "max_seats_snapshot"),
        CONSTRAINT "ck_subscriptions_seats_nonneg" CHECK ("used_seats" >= 0)
      )
    `);
    await enableTenantRls(queryRunner, 'subs.subscriptions');

    // §14.2's ONE documented cross-schema grant: app_user (user-service's
    // runtime role) gets SELECT/UPDATE on subs.subscriptions and NOTHING
    // ELSE in subs — no INSERT, no DELETE, no other table. This grant is
    // applied HERE, by user-service's migration, because user-service is the
    // one that needs it and this is the migration creating the table.
    // subscription-service's later migration must not re-grant or widen this.
    await queryRunner.query(`
      GRANT SELECT, UPDATE ON "subs"."subscriptions" TO app_user
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "subs"."subscriptions"`);
    await queryRunner.query(`DROP TABLE "users"."invitations"`);
    await queryRunner.query(`DROP TABLE "users"."users"`);
    await queryRunner.query(`DROP TYPE "users"."users_status_enum"`);
    await queryRunner.query(`DROP TYPE "users"."users_role_enum"`);
  }
}
