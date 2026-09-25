import { randomUUID } from 'node:crypto';
import { contextStore } from '../../src/lib/context-store';
import { subscribe } from '../../src/lib/events';
import { transactionForOrganization } from '../../src/lib/tenant-db';
import { Role } from '../../src/types/constants';
import type { EventEnvelope, Topic } from '../../src/types/events';
import type { TenantContextPayload } from '../../src/types/tenant-context';

/**
 * Shared fixtures for the Testcontainers integration suites. Everything here goes
 * through the app's own tenant-db helpers (so RLS scoping is set exactly as in
 * production) or through contextStore.run (so services see a real request context).
 */

export function contextFor(
  organizationId: string | null,
  userId: string,
  roles: Role[] = organizationId === null ? [Role.PLATFORM_ADMIN] : [Role.ORG_ADMIN],
): TenantContextPayload {
  return { userId, organizationId, roles, correlationId: randomUUID(), iat: 0, exp: 0 };
}

/** Runs `work` inside a request-shaped tenant context, as authenticate() would. */
export function runAs<T>(
  organizationId: string | null,
  userId: string,
  work: () => Promise<T>,
  roles?: Role[],
): Promise<T> {
  return contextStore.run(contextFor(organizationId, userId, roles), work);
}

/**
 * Records every envelope published on the given topics, the in-process equivalent of
 * the old fake EventPublisher. Call clearSubscriptions() in afterEach/afterAll.
 */
export function recordEvents(...topics: Topic[]): EventEnvelope[] {
  const seen: EventEnvelope[] = [];
  for (const topic of topics) {
    subscribe(topic, `TestRecorder(${topic})`, async (envelope) => {
      seen.push(envelope);
    });
  }
  return seen;
}

/**
 * Upserts an org's subscription row on the free plan with the given seat counters.
 * app_user has no DELETE on subscriptions, so re-seeding is an upsert, not delete+insert.
 */
export async function seedSubscription(
  organizationId: string,
  usedSeats: number,
  maxSeats: number,
  opts: { usedStorageBytes?: number; maxStorageBytes?: number } = {},
): Promise<void> {
  const usedStorage = opts.usedStorageBytes ?? 0;
  const maxStorage = opts.maxStorageBytes ?? 5_368_709_120;
  await transactionForOrganization(
    organizationId,
    (tx) =>
      tx.$executeRaw`
      INSERT INTO subscriptions
        (organization_id, plan_id, used_seats, max_seats_snapshot, used_storage_bytes, max_storage_snapshot)
      VALUES (${organizationId}::uuid, (SELECT id FROM plans WHERE code = 'free'),
              ${usedSeats}::int, ${maxSeats}::int, ${usedStorage}::bigint, ${maxStorage}::bigint)
      ON CONFLICT (organization_id) DO UPDATE
        SET used_seats = EXCLUDED.used_seats,
            max_seats_snapshot = EXCLUDED.max_seats_snapshot,
            used_storage_bytes = EXCLUDED.used_storage_bytes,
            max_storage_snapshot = EXCLUDED.max_storage_snapshot
    `,
  );
}

/** Inserts `count` active users for an org (each holds a seat, per D-Q1). */
export async function seedUsers(organizationId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  await transactionForOrganization(organizationId, async (tx) => {
    for (let i = 0; i < count; i++) {
      const user = await tx.user.create({
        data: {
          organizationId,
          email: `seed-${i}-${randomUUID().slice(0, 8)}@example.com`,
          firstName: 'Seed',
          lastName: `User${i}`,
          role: i === 0 ? 'org_admin' : 'org_member',
        },
      });
      ids.push(user.id);
    }
  });
  return ids;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise plus its resolver, for holding a transaction open at a known point. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
