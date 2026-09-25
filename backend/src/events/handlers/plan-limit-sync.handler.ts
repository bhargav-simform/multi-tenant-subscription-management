import { subscribe } from '../../lib/events';
import { createLogger } from '../../lib/logger';
import { transactionForOrganization } from '../../lib/tenant-db';
import * as planLimits from '../../models/plan-limit-cache.model';
import { EVENT_TYPES, TOPICS, type EventEnvelope } from '../../types/events';

const logger = createLogger('PlanLimitSyncHandler');

const PLAN_LIMIT_EVENTS: string[] = [
  EVENT_TYPES.SUBSCRIPTION_ASSIGNED,
  EVENT_TYPES.SUBSCRIPTION_CHANGED,
];

interface SubscriptionPlanPayload {
  maxStorageBytes?: number;
}

/**
 * SubscriptionAssigned / SubscriptionChanged -> plan_limit_cache.max_storage_bytes.
 * Writes the ceiling only; used_storage_bytes is preserved (a plan change moves the
 * ceiling, never the usage). Idempotent: the upsert sets an absolute value.
 */
export async function handle(envelope: EventEnvelope): Promise<void> {
  if (!PLAN_LIMIT_EVENTS.includes(envelope.eventType)) return;
  if (!envelope.organizationId) return;

  const payload = envelope.payload as SubscriptionPlanPayload;
  // No ceiling in the event: keep the previous one rather than guess.
  if (typeof payload.maxStorageBytes !== 'number') {
    logger.warn(
      `${envelope.eventType} ${envelope.eventId} carried no maxStorageBytes — ` +
        `plan_limit_cache not updated for organization ${envelope.organizationId}`,
    );
    return;
  }

  const organizationId = envelope.organizationId;
  const maxStorageBytes = payload.maxStorageBytes;
  await transactionForOrganization(organizationId, (tx) =>
    planLimits.upsert(tx, organizationId, maxStorageBytes),
  );
}

export function register(): void {
  subscribe(TOPICS.SUBSCRIPTION, 'PlanLimitSyncHandler', handle);
}
