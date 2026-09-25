import { subscribe } from '../../lib/events';
import { createLogger } from '../../lib/logger';
import { transactionForOrganization } from '../../lib/tenant-db';
import * as subscriptions from '../../models/subscription.model';
import { EVENT_TYPES, TOPICS, type EventEnvelope } from '../../types/events';

const logger = createLogger('MissingSubscriptionAlarmHandler');

const SEAT_AFFECTING_EVENTS: string[] = [
  EVENT_TYPES.USER_INVITED,
  EVENT_TYPES.USER_CREATED,
  EVENT_TYPES.USER_REMOVED,
  EVENT_TYPES.INVITATION_ACCEPTED,
  EVENT_TYPES.INVITATION_EXPIRED,
];

/**
 * A missing-row alarm, NOT drift detection: on any seat-affecting event it checks
 * the organisation has a subscription row and logs a security line if not. It never
 * compares or writes used_seats.
 */
export async function handle(envelope: EventEnvelope): Promise<void> {
  if (!SEAT_AFFECTING_EVENTS.includes(envelope.eventType)) return;
  if (!envelope.organizationId) return;

  const organizationId = envelope.organizationId;
  const exists = await transactionForOrganization(organizationId, (tx) =>
    subscriptions.existsForOrganization(tx, organizationId),
  );

  if (!exists) {
    logger.error(
      `security: seat-affecting event ${envelope.eventType} for organization ${organizationId} ` +
        `with NO subscription row — evidence of a code path that skipped onboarding's invariant`,
    );
  }
}

export function register(): void {
  subscribe(TOPICS.USER, 'MissingSubscriptionAlarmHandler', handle);
}
