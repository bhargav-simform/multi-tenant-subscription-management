/**
 * Postgres unique_violation (23505), however Prisma surfaces it: P2002 from the
 * query API, or the driver adapter's error for a raw query / constraint the Prisma
 * schema does not know about (e.g. the partial index uq_invitations_org_email_pending).
 */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as {
    code?: unknown;
    meta?: {
      code?: unknown;
      driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } };
    };
    cause?: unknown;
  };
  if (e.code === 'P2002') return '23505';
  if (e.code === '23505') return '23505';
  if (e.meta?.code === '23505') return '23505';
  const adapterCause = e.meta?.driverAdapterError?.cause;
  if (adapterCause?.originalCode === '23505' || adapterCause?.kind === 'UniqueConstraintViolation')
    return '23505';
  if (e.cause && e.cause !== err) return pgErrorCode(e.cause);
  return undefined;
}
