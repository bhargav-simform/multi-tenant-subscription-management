import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { TenantContextStore } from '@app/tenant-context';

/**
 * The single point through which tenant scoping is applied to the database
 * (§13.5, §15.3). Every transaction opened through this class has
 * `SET LOCAL app.current_org = <orgId>` issued before the callback runs, which is
 * what makes PostgreSQL's RLS policies filter every query automatically —
 * including a raw SQL query with no WHERE clause at all (§13.1's central claim).
 *
 * `SET LOCAL` (never `SET`) is deliberate: SET LOCAL is transaction-scoped, so it
 * cannot leak across a pooled connection onto a later, differently-scoped request
 * — the single most dangerous failure mode of this pattern (§13.5).
 *
 * A read-only query outside an explicit transaction is wrapped in an implicit one
 * for the same reason: SET LOCAL requires a transaction to be scoped to, and there
 * must be no code path where the variable is left unset.
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
        await queryRunner.query('SET LOCAL app.current_org = $1', [organizationId]);
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
