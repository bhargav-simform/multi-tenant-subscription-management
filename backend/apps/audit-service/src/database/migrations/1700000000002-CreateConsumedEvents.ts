import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §17.6: this service's own per-consumer idempotency table — identical in
 * shape to user-service's, subscription-service's and resource-service's.
 * Unqualified here because audit_db's tables live in the default `public`
 * schema (§14.1); user-service and subscription-service qualify theirs
 * (`users.`, `subs.`) only because they share core_db.
 *
 * Note this table is shared by all FIVE of this service's consumers, which is
 * correct and not a collision risk: `event_id` is globally unique across every
 * topic (a uuid minted per event by EventPublisher), and no event is delivered
 * to two of this service's consumers — each subscribes to exactly one topic.
 * Every consumer here also runs under the same Kafka group id, so an event is
 * consumed once by this service, not once per consumer class.
 *
 * SELECT + INSERT only, same as the other services' copies — a consumed marker
 * is never updated or retracted either.
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
    await queryRunner.query(`GRANT SELECT, INSERT ON "consumed_events" TO app_user`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "consumed_events"`);
  }
}
