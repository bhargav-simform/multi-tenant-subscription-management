import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * §32.4: fixes a real bug found via empirical Postgres testing in the
 * `tenant_isolation` policy `enableTenantRls()` created on every RLS-protected
 * table so far. `set_config('app.current_org', $1, true)` — the transaction-LOCAL
 * scoping `TenantAwareDataSource` issues every request — reverts the setting to
 * the EMPTY STRING on commit, never back to NULL, and that empty string
 * persists for the rest of that pooled connection's session. A later query on a
 * REUSED connection that has not re-scoped (runGlobal(), the pre-scope phase of
 * transactionWithDeferredScope, the platform-admin "leave it unset" path) then
 * evaluates `''::uuid`, which RAISES `invalid input syntax for type uuid`
 * instead of returning zero rows — a live production bug, since pool reuse
 * makes "a connection that has never run a scoped transaction" the rare case,
 * not the common one.
 *
 * This migration re-creates the policy on every table user-service's
 * migrations RLS-protected (users.users, users.invitations, and
 * subs.subscriptions — created here even though subscription-service also
 * touches that table, per §32.3's "whoever created it, fixes it" convention)
 * with `NULLIF(current_setting(...), '')` before the cast, restoring the
 * documented "no scope set -> zero rows" behaviour with no error on a reused
 * connection — confirmed against a real Postgres container. `enableTenantRls()`
 * itself is fixed for every FUTURE table; this migration is what closes the gap
 * for tables that already exist.
 */
export class FixRlsPolicyNullifEmptyString1700000000003 implements MigrationInterface {
  name = 'FixRlsPolicyNullifEmptyString1700000000003';

  private readonly tables = ['users.users', 'users.invitations', 'subs.subscriptions'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      const qualified = this.qualify(table);
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${qualified}`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ${qualified}
          USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
          WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of this.tables) {
      const qualified = this.qualify(table);
      await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON ${qualified}`);
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON ${qualified}
          USING      (organization_id = current_setting('app.current_org', true)::uuid)
          WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid)
      `);
    }
  }

  private qualify(table: string): string {
    return table
      .split('.')
      .map((part) => `"${part}"`)
      .join('.');
  }
}
