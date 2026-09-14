import { QueryRunner } from 'typeorm';

/**
 * Applies the standard RLS policy to a newly-created tenant table
 * (docs/architecture/ARCHITECTURE.md §13.5). MUST be called in the SAME migration
 * that creates the table — a follow-up migration leaves a window where the table
 * exists unprotected (§13.7 row 3, the one genuine bypass a missing call here
 * would open).
 *
 * FORCE is not optional: without it, the table owner (app_migrator) bypasses the
 * policy. WITH CHECK is not optional: without it, a write can plant a row in
 * another tenant.
 */
export async function enableTenantRls(queryRunner: QueryRunner, table: string): Promise<void> {
  await queryRunner.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  await queryRunner.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  await queryRunner.query(`
    CREATE POLICY tenant_isolation ON "${table}"
      USING      (organization_id = current_setting('app.current_org', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid)
  `);
}

export async function disableTenantRls(queryRunner: QueryRunner, table: string): Promise<void> {
  await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);
  await queryRunner.query(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
  await queryRunner.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
}
