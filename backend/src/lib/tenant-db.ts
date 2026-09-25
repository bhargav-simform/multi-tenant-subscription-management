import type { Prisma } from '../generated/prisma/client';
import { contextStore } from './context-store';
import { getPrisma } from './prisma';
import { createLogger } from './logger';

/** A Prisma interactive-transaction client. Every model function takes one. */
export type Tx = Prisma.TransactionClient;

const logger = createLogger('TenantDb');

/**
 * Prisma's interactive transactions default to a 5s timeout, far shorter than a
 * seat-lock queue under concurrent invites can take. These match "wait for the
 * lock, then do a few statements" rather than any long-running work.
 */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Scopes the transaction to one organisation. This single statement is what makes
 * PostgreSQL's RLS policies filter every later query in the transaction — including
 * a raw SELECT with no WHERE clause at all.
 *
 * set_config(..., true), not SET LOCAL: SET does not accept bind parameters, and an
 * organisation id is not something to interpolate into SQL text. The `true` makes it
 * transaction-local, so it can never leak onto a later request that reuses the
 * pooled connection.
 */
async function setScope(tx: Tx, organizationId: string): Promise<void> {
  await tx.$queryRaw`SELECT set_config('app.current_org', ${organizationId}, true)`;
}

async function runScoped<T>(
  organizationId: string | null,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return getPrisma().$transaction(async (tx) => {
    if (organizationId === null) {
      // Platform admin: leave app.current_org unset. Every tenant policy then
      // evaluates to NULL, so content queries return zero rows — not a special
      // case in application code, it falls out of the policy definition.
      logger.debug('Scoped transaction with no organizationId (platform admin context)');
    } else {
      await setScope(tx, organizationId);
    }
    return work(tx);
  }, TX_OPTIONS);
}

/**
 * The standard entry point for request-path work: scoped to the caller's org from
 * the request context. Throws if there is no context.
 */
export async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  const ctx = contextStore.getOrThrow();
  return runScoped(ctx.organizationId, work);
}

/**
 * For work outside a request that still belongs to one organisation: event
 * handlers (org from the envelope), the invitation sweep, and the invitation
 * "peek" before acceptance.
 */
export async function transactionForOrganization<T>(
  organizationId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return runScoped(organizationId, work);
}

/**
 * The explicit, auditable escape hatch: a transaction with NO tenant scope. Used for
 * registry tables (credentials, organizations, sagas), the plan catalogue, NULL-org
 * audit rows, and the SECURITY DEFINER lookups. On a tenant table it returns zero
 * rows — that is RLS working, not a bug.
 */
export async function runGlobal<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  logger.warn('runGlobal() invoked — bypassing tenant scoping by design');
  return getPrisma().$transaction(work, TX_OPTIONS);
}

/**
 * One transaction that must look up which organisation it belongs to before it can
 * be scoped (invitation acceptance): it starts UNSCOPED, and `scope(orgId)` applies
 * RLS scoping to every query after it, atomically in the same transaction.
 */
export async function transactionWithDeferredScope<T>(
  work: (tx: Tx, scope: (organizationId: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  return getPrisma().$transaction(
    async (tx) => work(tx, (organizationId) => setScope(tx, organizationId)),
    TX_OPTIONS,
  );
}

/**
 * Boot-time check: refuse to start if the connected role can bypass RLS. A
 * misconfigured deployment (connecting as the table owner or a superuser) must fail
 * closed, not silently disable the isolation guarantee.
 */
export async function assertRlsSafeRole(): Promise<void> {
  const [row] = await getPrisma().$queryRaw<
    { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >`
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
  `;
  if (!row) {
    throw new Error('Could not resolve current_user role for RLS safety check');
  }
  if (row.rolsuper) {
    throw new Error(
      `FATAL: database role "${row.rolname}" is a superuser. Superusers bypass Row-Level Security ` +
        `entirely. Refusing to start — connect as app_user instead.`,
    );
  }
  if (row.rolbypassrls) {
    throw new Error(
      `FATAL: database role "${row.rolname}" has BYPASSRLS. Refusing to start — tenant isolation ` +
        `depends on this role being unable to bypass RLS.`,
    );
  }
  logger.info(`RLS safety check passed: role "${row.rolname}" is non-superuser, NOBYPASSRLS`);
}
