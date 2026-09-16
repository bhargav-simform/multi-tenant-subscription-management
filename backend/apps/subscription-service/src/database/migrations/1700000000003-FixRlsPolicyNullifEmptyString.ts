import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §32.4: companion to user-service's identically-named migration — see that
 * file's header comment for the full explanation. This one fixes the one
 * table subscription-service's own migrations created and RLS-protected:
 * subs.subscription_history. (subs.subscriptions is fixed by user-service's
 * migration, since user-service created that table — §32.3's convention.)
 */
export class FixRlsPolicyNullifEmptyString1700000000003 implements MigrationInterface {
  name = 'FixRlsPolicyNullifEmptyString1700000000003';

  private readonly table = '"subs"."subscription_history"';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${this.table}`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON ${this.table}
        USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
        WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${this.table}`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON ${this.table}
        USING      (organization_id = current_setting('app.current_org', true)::uuid)
        WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid)
    `);
  }
}
