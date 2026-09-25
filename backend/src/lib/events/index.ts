import { randomUUID } from 'node:crypto';
import { contextStore } from '../context-store';
import { createLogger } from '../logger';
import type { DomainEvent, EventEnvelope, Topic } from '../../types/events';

/**
 * In-process replacement for the Kafka producer/consumers.
 *
 * Contract, unchanged from the Kafka design:
 *   - Services call publish() AFTER their transaction commits, never inside it.
 *   - Publishing never throws back to the caller: the request already succeeded, and
 *     audit must never fail a user request. Handler failures are logged and dropped.
 *
 * What differs: handlers run in this process and are awaited, so their effects (the
 * first admin user, the storage-limit cache, audit rows) exist before the HTTP
 * response is sent instead of "shortly after". There is no retry/DLQ.
 */
export type EventHandler = (envelope: EventEnvelope) => Promise<void>;

interface Registration {
  name: string;
  handle: EventHandler;
}

const logger = createLogger('EventBus');
const handlers = new Map<Topic, Registration[]>();

/** Registers a handler for every event on a topic. Handlers run in registration order. */
export function subscribe(topic: Topic, name: string, handle: EventHandler): void {
  const list = handlers.get(topic) ?? [];
  list.push({ name, handle });
  handlers.set(topic, list);
}

/** For tests. */
export function clearSubscriptions(): void {
  handlers.clear();
}

export async function publish<T>(topic: Topic, event: DomainEvent<T>): Promise<void> {
  await publishAll(topic, [event]);
}

export async function publishAll<T>(topic: Topic, events: DomainEvent<T>[]): Promise<void> {
  if (events.length === 0) return;

  const correlationId = contextStore.get()?.correlationId || randomUUID();
  const occurredAt = new Date().toISOString();

  for (const event of events) {
    const envelope: EventEnvelope<T> = {
      eventId: randomUUID(),
      eventType: event.eventType,
      eventVersion: 1,
      organizationId: event.organizationId,
      correlationId,
      causationId: event.causationId,
      actorUserId: event.actorUserId,
      occurredAt,
      payload: event.payload,
    };
    await dispatch(topic, envelope);
  }
}

async function dispatch(topic: Topic, envelope: EventEnvelope): Promise<void> {
  for (const { name, handle } of handlers.get(topic) ?? []) {
    try {
      // Each handler gets a scope built from the envelope, not the caller's ambient
      // context — exactly what a Kafka consumer saw.
      await contextStore.run(
        {
          userId: envelope.actorUserId ?? 'system',
          organizationId: envelope.organizationId,
          roles: [],
          correlationId: envelope.correlationId,
          iat: 0,
          exp: 0,
        },
        () => handle(envelope),
      );
    } catch (err) {
      logger.error(
        { err, eventId: envelope.eventId, eventType: envelope.eventType, topic, handler: name },
        `Event handler ${name} failed for ${envelope.eventType}: ${(err as Error).message}`,
      );
    }
  }
}
