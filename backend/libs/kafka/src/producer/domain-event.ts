import type { EventType } from '@app/common';

/**
 * What an application service collects during a transaction and hands to the
 * publisher AFTER commit (§17.5). Never constructed with an eventId/occurredAt —
 * the publisher stamps those, so a service cannot accidentally publish inside
 * its own transaction by constructing a full envelope early.
 */
export interface DomainEvent<TPayload = unknown> {
  eventType: EventType;
  organizationId: string | null;
  actorUserId: string | null;
  payload: TPayload;
  causationId?: string;
}
