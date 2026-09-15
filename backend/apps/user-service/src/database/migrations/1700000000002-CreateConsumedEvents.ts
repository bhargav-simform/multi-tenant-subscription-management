import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §17.6: per-consumer idempotency table. Not tenant data — it holds no
 * organization_id at all, so it is a GLOBAL table (registered in
 * GLOBAL_TABLES alongside `plans`), not RLS-protected.
 */
export class CreateConsumedEvents1700000000002 implements MigrationInterface {
  name = 'CreateConsumedEvents1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users"."consumed_events" (
        "event_id" uuid PRIMARY KEY,
        "consumed_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "users"."consumed_events"`);
  }
}
