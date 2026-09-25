import type {
  OnboardingSaga as PrismaOnboardingSaga,
  OnboardingSagaState,
} from '../generated/prisma/client';
import type { Tx } from '../lib/tenant-db';

/**
 * The forward-recovery state machine for self-service onboarding:
 *
 *   pending -> org_created -> credentials_created -> subscribed -> complete
 *
 * `state` ALWAYS holds the last step that succeeded — a failure never overwrites it,
 * it only sets failedAt + lastError alongside, so a retry resumes from `state`.
 * idempotency_key is unique: a double-submitted signup resumes, never duplicates.
 * A registry table (no RLS).
 */
export const SagaState = {
  PENDING: 'pending',
  ORG_CREATED: 'org_created',
  CREDENTIALS_CREATED: 'credentials_created',
  SUBSCRIBED: 'subscribed',
  COMPLETE: 'complete',
} as const satisfies Record<string, OnboardingSagaState>;

export type SagaState = OnboardingSagaState;

export interface OnboardingSaga {
  id: string;
  idempotencyKey: string;
  organizationId: string | null;
  state: SagaState;
  adminEmail: string;
  adminUserId: string | null;
  lastError: string | null;
  failedAt: Date | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

function toSaga(row: PrismaOnboardingSaga): OnboardingSaga {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    organizationId: row.organizationId,
    state: row.state,
    adminEmail: row.adminEmail,
    adminUserId: row.adminUserId,
    lastError: row.lastError,
    failedAt: row.failedAt,
    attempts: row.attempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function findByIdempotencyKey(db: Tx, key: string): Promise<OnboardingSaga | null> {
  const row = await db.onboardingSaga.findUnique({ where: { idempotencyKey: key } });
  return row ? toSaga(row) : null;
}

export async function create(
  db: Tx,
  data: { idempotencyKey: string; adminEmail: string },
): Promise<OnboardingSaga> {
  return toSaga(
    await db.onboardingSaga.create({ data: { ...data, state: SagaState.PENDING, attempts: 0 } }),
  );
}

/**
 * Records a successful step: moves `state` forward and clears any prior failure.
 * The only function that changes `state`.
 */
export async function advance(
  db: Tx,
  id: string,
  state: SagaState,
  patch: Partial<Pick<OnboardingSaga, 'organizationId' | 'adminUserId'>>,
): Promise<void> {
  await db.onboardingSaga.updateMany({
    where: { id },
    data: { attempts: { increment: 1 }, state, failedAt: null, lastError: null, ...patch },
  });
}

/** Records a failed attempt WITHOUT touching `state` — the resume point survives. */
export async function markFailed(db: Tx, id: string, error: string): Promise<void> {
  await db.onboardingSaga.updateMany({
    where: { id },
    data: { attempts: { increment: 1 }, lastError: error, failedAt: new Date() },
  });
}
