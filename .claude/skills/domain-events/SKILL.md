---
name: domain-events
description: >
  Add or modify domain events and event handlers on the backend's in-process event
  bus (lib/events). Use when: publishing a domain event, writing or changing a handler
  in src/events/handlers, adding an event type or channel, wiring audit for a new
  action, or when the user says "publish event", "emit event", "event handler",
  "consumer", "subscribe", "event-driven", "audit this". Use a direct function call,
  not an event, when the caller needs an answer.
---

# Domain Events (in-process bus)

Reference: `docs/architecture/ARCHITECTURE.md` §0.4, §17 (catalogue and envelope still
apply). Code: `backend/src/lib/events/index.ts`, `backend/src/types/events.ts`,
`backend/src/events/`.

There is **no Kafka and no broker.** `publish()` dispatches to handlers registered in
the same process.

## The rule

> **Call a function when the caller cannot continue without the answer.
> Publish an event when another module merely needs to react.**

Never use an event for limit enforcement (that is the locked transaction —
`concurrency-safety` skill), for request/response, or for reading another module's data.

## Semantics — know these before relying on an event

| Property | Behaviour |
|---|---|
| When | `publish()` / `publishAll()` must be called **after** the transaction commits — never with a `tx` in scope. A rolled-back event is a lie |
| Dispatch | Handlers for the channel run **sequentially, in registration order**, and are **awaited** — the publishing request responds after they finish |
| Scope | Each handler runs in a fresh `contextStore` scope built from the envelope (`organizationId`, `actorUserId`, `correlationId`, no roles) — never the publisher's ambient context |
| Failure | A handler that throws is logged at `error` and skipped; the next handler still runs; `publish()` never throws to the caller |
| Delivery | At-most-once, best-effort. **No retry, no DLQ, no dedupe table** (`consumed_events` is gone) |
| Envelope | Stamped by the bus: `eventId`, `eventType`, `eventVersion: 1`, `organizationId`, `correlationId` (from the request, else a new UUID), `causationId`, `actorUserId`, `occurredAt`, `payload` |

Consequences:

- A handler's effect can be lost; never make correctness depend on it. Display counters
  and audit are fine; enforcement is not.
- Handlers add latency to the publishing request — keep them to one small transaction.
- `correlationId` flows into the `uuid` column of the audit tables; a non-UUID client
  `x-correlation-id` makes the audit insert fail (known, §0.5 #7).

## Publishing

```ts
const created = await transaction(async (tx) => { /* writes */ });   // COMMIT
await publish(TOPICS.RESOURCE, {
  eventType: EVENT_TYPES.RESOURCE_CREATED,
  organizationId,                                // null only for platform-level events
  actorUserId: contextStore.get()?.userId ?? null,
  payload: { resourceId: created.id, sizeDelta: created.sizeBytes },
});
```

Payloads are persisted **verbatim** into `audit_events` / `security_events`, so: no
secrets, no password hashes, no raw tokens; changing an existing payload shape changes
the audit record.

## Writing a handler

```ts
// backend/src/events/handlers/project-archived.handler.ts
export async function handle(envelope: EventEnvelope): Promise<void> {
  if (envelope.eventType !== EVENT_TYPES.PROJECT_ARCHIVED) return;   // channels carry many types
  if (!envelope.organizationId) return;
  const organizationId = envelope.organizationId;
  await transactionForOrganization(organizationId, (tx) => /* model calls */);
}
export function register(): void {
  subscribe(TOPICS.PROJECT, 'ProjectArchivedHandler', handle);
}
```

- Filter on `eventType` first.
- Scope explicitly with `transactionForOrganization(envelope.organizationId, ...)`
  (or `transaction(...)`, which reads the envelope-built scope). `runGlobal` only for
  genuinely global writes (NULL-org audit rows).
- Idempotent anyway (absolute upserts, `ON CONFLICT`) — cheap insurance and it keeps an
  outbox/broker upgrade possible.
- Register it in `backend/src/events/index.ts` `registerEventHandlers()`: **domain
  handlers before the audit sinks**, so an audit row is written after the effect it
  records.

## Adding an event type or channel

- Add the type to `EVENT_TYPES` (and a channel to `TOPICS` if genuinely new) in
  `types/events.ts`, and the row to ARCHITECTURE.md §17.3.
- Every event on `organization/user/subscription/resource` channels is audited by
  `audit-sink.handler.ts` automatically; a new content channel must be added to its
  `CONTENT_TOPICS`. `security.events` goes to `security_events` at `security` severity.

## Existing handlers

| Handler | Reacts to | Effect |
|---|---|---|
| `organization-provisioned` | `OrganizationProvisioned` | Creates the first `org_admin` user with the credential's id |
| `plan-limit-sync` | `SubscriptionAssigned` / `SubscriptionChanged` | Upserts `plan_limit_cache.max_storage_bytes` (clamped to usage) |
| `storage-reconciliation` | `ResourceCreated` / `ResourceDeleted` | Adjusts display-only `subscriptions.used_storage_bytes` |
| `missing-subscription-alarm` | seat-affecting `user.events` | Logs a security line if the org has no subscription row |
| `audit-sink` | all content channels | `audit_events` (`warn` for `PlanLimitExceeded`) |
| `security-events` | `security.events` | `security_events` |

## Checklist

- [ ] Nothing waits for the result (otherwise: a direct call)
- [ ] Published after commit, outside any `tx`
- [ ] Payload safe to persist verbatim
- [ ] Handler filters on `eventType`, scopes explicitly, is idempotent
- [ ] Registered in `events/index.ts`, before the audit sinks
- [ ] Correctness does not depend on the handler succeeding
- [ ] §17.3 catalogue updated; unit test for the handler
