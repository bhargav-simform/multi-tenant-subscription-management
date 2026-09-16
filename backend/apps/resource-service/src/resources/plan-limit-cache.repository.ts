import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { PlanLimitCache } from './plan-limit-cache.entity';
import type {
  IPlanLimitCacheRepository,
  StorageSnapshot,
} from './plan-limit-cache.repository.interface';

@Injectable()
export class PlanLimitCacheRepository implements IPlanLimitCacheRepository {
  /**
   * §19.6, §19.2: `SELECT ... FOR UPDATE` — the single most important line in
   * this service. It is what makes a second concurrent create WAIT and then
   * RE-READ the counter after the first commits, rather than acting on the
   * stale value it would otherwise have seen (§19.3). Mirrors
   * user-service's SubscriptionSeatRepository.lockForUpdate exactly.
   *
   * MISSING-ROW BEHAVIOUR — a deliberate decision, not an oversight.
   * This row is populated ASYNCHRONOUSLY, by SubscriptionChangedConsumer
   * reading subscription-service's events (§8.6 "Consumes"). So unlike
   * user-service's subscription row — which onboarding creates
   * SYNCHRONOUSLY, making its absence a genuine invariant violation and
   * therefore honestly a 500 — a missing row here has an entirely benign and
   * expected cause: the organisation is new and its SubscriptionAssigned
   * event has not been consumed yet. That is a transient, retryable state,
   * so this throws 503 with a Retry-After-shaped message rather than 500.
   *
   * WHAT IT MUST NOT DO, and why: it must NEVER fall back to a permissive
   * default (unlimited storage, or a generous hardcoded ceiling). Doing so
   * would make "the event hasn't arrived yet" a window in which the plan
   * limit is not enforced at all — a limit that silently does not apply is
   * strictly worse than a request that fails loudly and can be retried. A
   * restrictive hardcoded default (e.g. 0 bytes) was the other option
   * considered; it fails closed correctly but reports the wrong reason to the
   * caller ("you are out of storage" when in truth the service does not yet
   * know their ceiling), which R6's "clear, specific message" requirement
   * rules out. Failing closed AND honestly is the combination chosen.
   *
   * Tracked in ARCHITECTURE.md §32.3 as a real, if narrow, limitation: there
   * is a window after an organisation is provisioned during which resource
   * creation returns 503.
   */
  async lockForUpdate(organizationId: string, manager: EntityManager): Promise<StorageSnapshot> {
    const row = await manager
      .createQueryBuilder(PlanLimitCache, 'plc')
      .setLock('pessimistic_write')
      .where('plc.organizationId = :organizationId', { organizationId })
      .getOne();

    if (!row) {
      throw new ServiceUnavailableException(
        'Your plan\'s storage limit is not available yet — this organisation\'s subscription ' +
          'details are still being synchronised. Please retry in a few seconds.',
      );
    }
    return { usedStorageBytes: row.usedStorageBytes, maxStorageBytes: row.maxStorageBytes };
  }

  async findByOrganizationId(
    organizationId: string,
    manager: EntityManager,
  ): Promise<PlanLimitCache | null> {
    return manager.getRepository(PlanLimitCache).findOne({ where: { organizationId } });
  }

  /**
   * §8.6: consumer-only. `used_storage_bytes` is EXCLUDED from the UPDATE set
   * on conflict — a plan change moves the ceiling, never the usage. Resetting
   * it to 0 here would silently free every byte an organisation had used, and
   * would desynchronise the authoritative counter from its rows.
   *
   * The INSERT branch starts used_storage_bytes at 0, which is correct for
   * the only case that reaches it: the first event for a newly-provisioned
   * organisation, which by definition has no resources yet.
   *
   * THE DOWNGRADE EDGE CASE. `ck_plan_limit_storage` enforces
   * used_storage_bytes <= max_storage_bytes, so LOWERING the ceiling below
   * current usage would violate it and throw — sending the event to the DLQ
   * (§17.6) and leaving this service stuck on a stale ceiling permanently.
   * §19.10 makes that case rare by design: subscription-service REJECTS a
   * downgrade whose target plan is below current usage, inside its own locked
   * transaction, so a SubscriptionChanged event that breaches this constraint
   * should not be produced at all. "Should not" is not "cannot", though —
   * subscription-service compares against ITS OWN used_storage_bytes, which
   * §8.5 states plainly is an eventually-consistent DISPLAY value derived
   * from this service's events, and which can therefore lag this service's
   * authoritative counter at the moment it decides.
   *
   * So the ceiling is clamped to at least the current usage rather than
   * allowed to throw. The consequence is explicit and worth stating: for the
   * window until usage drops, this organisation's effective ceiling is its
   * usage, so every new resource is rejected (the limit binds immediately)
   * while no existing resource is retroactively invalidated. That is the
   * correct failure direction — it fails closed for new writes, never
   * silently raises a ceiling, and never wedges the consumer on the DLQ.
   */
  async upsert(
    organizationId: string,
    maxStorageBytes: number,
    manager: EntityManager,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO plan_limit_cache (organization_id, max_storage_bytes, used_storage_bytes, updated_at)
       VALUES ($1, $2, 0, now())
       ON CONFLICT (organization_id) DO UPDATE
         SET max_storage_bytes = GREATEST(
               EXCLUDED.max_storage_bytes,
               plan_limit_cache.used_storage_bytes
             ),
             updated_at        = now()`,
      [organizationId, maxStorageBytes],
    );
  }

  async adjustUsedStorageBytes(
    organizationId: string,
    delta: number,
    manager: EntityManager,
  ): Promise<void> {
    assertSafeInt(delta);
    await manager
      .createQueryBuilder()
      .update(PlanLimitCache)
      .set({
        usedStorageBytes: () => 'used_storage_bytes + :delta',
        updatedAt: () => 'now()',
      })
      .where('organizationId = :organizationId', { organizationId })
      .setParameter('delta', delta)
      .execute();
  }
}

/**
 * `delta` is a byte count originating from a validated DTO (CreateResourceDto's
 * @IsInt sizeBytes) or from a stored row's size_bytes — never free-form user
 * input, and always bound as a query parameter (`:delta`) rather than
 * interpolated into SQL text, so this is not a §25.1 injection concern either
 * way. Kept as an explicit assertion for the same reason
 * SubscriptionSeatRepository.adjustUsedSeats has one: a non-integer here means
 * a caller-side bug, and failing loudly beats silently corrupting the
 * authoritative counter.
 */
function assertSafeInt(value: number): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`adjustUsedStorageBytes delta must be an integer, got ${value}`);
  }
}
