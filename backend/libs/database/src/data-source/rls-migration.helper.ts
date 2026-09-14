import { QueryRunner } from 'typeorm';

/**
 * Quotes a table identifier that may be schema-qualified ("users.users" ->
 * "users"."users") or bare ("organizations" -> "organizations"). Wrapping the
 * whole dotted string in one pair of quotes (`"users.users"`) is a DIFFERENT,
 * INVALID identifier in Postgres — it names a single object literally
 * containing a dot, not a table in a schema. Every schema-qualified table
 * this helper touches (users.users, users.invitations — §14.2) depends on
 * this being right.
 */
function qualifyIdentifier(table: string): string {
  return table
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');
}

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
 *
 * `table` may be bare ("resources") or schema-qualified ("users.users" — §14.2's
 * per-service schemas inside the shared core_db).
 */
export async function enableTenantRls(queryRunner: QueryRunner, table: string): Promise<void> {
  const qualified = qualifyIdentifier(table);
  await queryRunner.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`);
  await queryRunner.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`);
  await queryRunner.query(`
    CREATE POLICY tenant_isolation ON ${qualified}
      USING      (organization_id = current_setting('app.current_org', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid)
  `);
}

export async function disableTenantRls(queryRunner: QueryRunner, table: string): Promise<void> {
  const qualified = qualifyIdentifier(table);
  await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${qualified}`);
  await queryRunner.query(`ALTER TABLE ${qualified} NO FORCE ROW LEVEL SECURITY`);
  await queryRunner.query(`ALTER TABLE ${qualified} DISABLE ROW LEVEL SECURITY`);
}
