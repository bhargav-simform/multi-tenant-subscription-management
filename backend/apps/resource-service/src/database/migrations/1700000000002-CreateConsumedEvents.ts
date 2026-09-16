import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §17.6: per-consumer idempotency table — this service's own copy, identical
 * in shape to user-service's and subscription-service's. Unqualified here
 * because resource_db's tables live in the default `public` schema (§14.1);
 * the other two services qualify theirs (`users.`, `subs.`) only because they
 * share core_db.
 */
export class CreateConsumedEvents1700000000002 implements MigrationInterface {
  name = 'CreateConsumedEvents1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "consumed_events" (
        "event_id" uuid PRIMARY KEY,
        "consumed_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      GRANT SELECT, INSERT ON "consumed_events" TO app_user
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "consumed_events"`);
  }
}
