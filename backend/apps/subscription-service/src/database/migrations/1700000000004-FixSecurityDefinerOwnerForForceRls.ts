import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §13.6, §32.4: companion to user-service's identically-named migration —
 * see that file's header comment for the full explanation of why a SECURITY
 * DEFINER function owned by a NOBYPASSRLS role gets no RLS bypass under
 * FORCE ROW LEVEL SECURITY, confirmed empirically.
 *
 * `subs.get_usage_aggregates` (created in CreatePlansAndExtendSubscriptions,
 * owned by app_migrator) reads `subs.subscriptions`, which is
 * FORCE-protected — this function has always returned zero rows in
 * production, for every organisation, not the usage aggregate UsageService
 * depends on. Fixed the same way: transfer ownership to `app_rls_bypass`
 * (§13.6) and grant it SELECT on both tables the function joins.
 */
export class FixSecurityDefinerOwnerForForceRls1700000000004 implements MigrationInterface {
  name = 'FixSecurityDefinerOwnerForForceRls1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER FUNCTION "subs"."get_usage_aggregates"(uuid) OWNER TO app_rls_bypass`,
    );
    await queryRunner.query(`GRANT SELECT ON "subs"."subscriptions" TO app_rls_bypass`);
    await queryRunner.query(`GRANT SELECT ON "subs"."plans" TO app_rls_bypass`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE SELECT ON "subs"."plans" FROM app_rls_bypass`);
    await queryRunner.query(`REVOKE SELECT ON "subs"."subscriptions" FROM app_rls_bypass`);
    await queryRunner.query(
      `ALTER FUNCTION "subs"."get_usage_aggregates"(uuid) OWNER TO app_migrator`,
    );
  }
}
