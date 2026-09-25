import { EVENT_TYPES, TOPICS, type EventEnvelope } from '../../types/events';
import { subscribe } from '../../lib/events';
import { createLogger } from '../../lib/logger';
import { recordEnvelope } from './audit-sink.handler';

const logger = createLogger('SecurityEventsSink');

const KNOWN_SECURITY_EVENT_TYPES: readonly string[] = [
  EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED,
  EVENT_TYPES.AUTHENTICATION_FAILED,
];

/** Every security.events message lands in security_events at severity 'security'. */
async function handle(envelope: EventEnvelope): Promise<void> {
  if (!KNOWN_SECURITY_EVENT_TYPES.includes(envelope.eventType)) {
    // Recorded anyway: an unknown security signal is still a security signal.
    logger.warn(
      `Unrecognised event type "${envelope.eventType}" on ${TOPICS.SECURITY} ` +
        `(event ${envelope.eventId}) — recording at 'security' severity regardless`,
    );
  }
  await recordEnvelope('security', envelope, 'security');
}

export function register(): void {
  subscribe(TOPICS.SECURITY, 'SecurityEventsSink', handle);
}
