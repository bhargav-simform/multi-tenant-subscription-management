import { MigrationInterface, QueryRunner } from 'typeorm';

/** §17.6: per-consumer idempotency table — this service's own copy (see user-service's identical pattern). */
export class CreateConsumedEvents1700000000002 implements MigrationInterface {
  name = 'CreateConsumedEvents1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "subs"."consumed_events" (
        "event_id" uuid PRIMARY KEY,
        "consumed_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      GRANT SELECT, INSERT ON "subs"."consumed_events" TO app_user
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "subs"."consumed_events"`);
  }
}
