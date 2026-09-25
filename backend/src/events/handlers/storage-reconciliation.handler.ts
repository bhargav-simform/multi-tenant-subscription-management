import { subscribe } from '../../lib/events';
import { transactionForOrganization } from '../../lib/tenant-db';
import * as subscriptions from '../../models/subscription.model';
import { EVENT_TYPES, TOPICS, type EventEnvelope } from '../../types/events';

interface ResourceEventPayload {
  sizeDelta?: number;
}

/**
 * ResourceCreated / ResourceDeleted -> subscriptions.used_storage_bytes. A DISPLAY
 * value only (the real limit is plan_limit_cache, enforced in the resource
 * transaction), so it is clamped to both bounds of ck_subscriptions_storage rather
 * than ever being rejected by it.
 */
export async function handle(envelope: EventEnvelope): Promise<void> {
  if (
    envelope.eventType !== EVENT_TYPES.RESOURCE_CREATED &&
    envelope.eventType !== EVENT_TYPES.RESOURCE_DELETED
  ) {
    return;
  }
  if (!envelope.organizationId) return;

  const organizationId = envelope.organizationId;
  const payload = envelope.payload as ResourceEventPayload;
  const delta =
    envelope.eventType === EVENT_TYPES.RESOURCE_CREATED
      ? (payload.sizeDelta ?? 0)
      : -(payload.sizeDelta ?? 0);

  await transactionForOrganization(organizationId, async (tx) => {
    const subscription = await subscriptions.findByOrganizationId(tx, organizationId);
    if (!subscription) return;
    const next = Math.min(
      subscription.maxStorageSnapshot,
      Math.max(0, subscription.usedStorageBytes + delta),
    );
    await subscriptions.updateUsedStorageBytes(tx, organizationId, next);
  });
}

export function register(): void {
  subscribe(TOPICS.RESOURCE, 'StorageReconciliationHandler', handle);
}
