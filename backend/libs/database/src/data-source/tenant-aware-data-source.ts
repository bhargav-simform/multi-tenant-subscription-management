import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { TenantContextStore } from '@app/tenant-context';

/**
 * The single point through which tenant scoping is applied to the database
 * (§13.5, §15.3). Every transaction opened through this class scopes
 * `app.current_org` to the current org before the callback runs, which is
 * what makes PostgreSQL's RLS policies filter every query automatically —
 * including a raw SQL query with no WHERE clause at all (§13.1's central claim).
 *
 * Scoping is done via `SELECT set_config('app.current_org', $1, true)`, NOT
 * `SET LOCAL app.current_org = $1` — PostgreSQL's `SET`/`SET LOCAL` statements
 * do not accept bind parameters at all (`syntax error at or near "$1"`,
 * verified against a real Postgres container), so the literal-interpolation
 * form this class used to use would have been the only alternative, and
 * organizationId is not a value to interpolate into SQL text. `set_config`'s
 * third argument (`true` = local) gives the exact same transaction-scoping
 * guarantee `SET LOCAL` does — it cannot leak across a pooled connection onto
 * a later, differently-scoped request, the single most dangerous failure mode
 * of this pattern (§13.5) — while accepting a normal parameterized argument.
 *
 * A read-only query outside an explicit transaction is wrapped in an implicit one
 * for the same reason: this scoping requires a transaction to apply "local" to, and
 * there must be no code path where the variable is left unset.
 */
@Injectable()
export class TenantAwareDataSource {
  private readonly logger = new Logger(TenantAwareDataSource.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextStore,
  ) {}

  /**
   * Standard entry point. Requires tenant context to be present (throws otherwise
   * — see TenantContextStore.getOrThrow). Use for all ordinary request-path work.
   */
  async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const ctx = this.tenantContext.getOrThrow();
    return this.runScoped(ctx.organizationId, work);
  }

  /**
   * Explicit escape hatch for code that is NOT request-scoped and genuinely has no
   * single tenant: migrations, the plan catalogue, and a Kafka consumer BEFORE it
   * establishes its own per-event tenant scope (§13.4 "across Kafka").
   *
   * This is deliberately not the default. Every caller of runGlobal() is a
   * reviewable, auditable exception — never a parameter that flips off scoping.
   */
  async runGlobal<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    this.logger.warn('runGlobal() invoked — bypassing tenant scoping by design');
    return this.dataSource.transaction(work);
  }

  /**
   * Used by consumers (§13.4 "across Kafka") and the invitation-expiry sweep
   * (§19.9), which are not inside an HTTP request and so have no ALS context —
   * they pass the organizationId explicitly, taken from the event envelope or
   * from iterating the organizations table.
   */
  async transactionForOrganization<T>(
    organizationId: string,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.runScoped(organizationId, work);
  }

  /**
   * §19.8's exact case: a single transaction that must LOOK UP which
   * organisation it belongs to (from a token, in user-service's invitation
   * acceptance) before it can be scoped — and must do the lookup and the
   * scoped work atomically, in one lock, rather than two separate
   * transactions with a gap between them.
   *
   * `work` receives a `setScope(organizationId)` callback. The transaction
   * begins with app.current_org UNSET (like runGlobal) — RLS-protected reads
   * before calling setScope() return nothing, by the same mechanism as
   * everywhere else in this file, which is why the initial lookup a caller
   * does here MUST be on a non-RLS column set (e.g. a lookup keyed by a
   * cryptographically random single-use token is the authorization itself —
   * §11.5's reasoning for why that route is public at all) or via one of the
   * narrow named exceptions in §13.6 (the SECURITY DEFINER function pattern).
   * Once setScope() is called, every subsequent query in this same
   * transaction is RLS-scoped exactly as if `transaction()` had been used
   * from the start — including the initial rows read before scoping, which
   * remain visible only because they were already fetched into memory, not
   * because RLS retroactively applies to them.
   */
  async transactionWithDeferredScope<T>(
    work: (manager: EntityManager, setScope: (organizationId: string) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const setScope = async (organizationId: string): Promise<void> => {
        await queryRunner.query("SELECT set_config('app.current_org', $1, true)", [organizationId]);
      };
      const result = await work(queryRunner.manager, setScope);
      await queryRunner.commitTransaction();
      return result;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private async runScoped<T>(
    organizationId: string | null,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      if (organizationId === null) {
        // Platform admin: leave app.current_org unset. Every RLS policy on every
        // tenant table then evaluates to NULL (not true), so content queries
        // structurally return zero rows (§13.6). This is not a special case in
        // application code — it falls out of the policy definition itself.
        this.logger.debug('Scoped transaction with no organizationId (platform admin context)');
      } else {
        await queryRunner.query("SELECT set_config('app.current_org', $1, true)", [organizationId]);
      }
      const result = await work(queryRunner.manager);
      await queryRunner.commitTransaction();
      return result;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
