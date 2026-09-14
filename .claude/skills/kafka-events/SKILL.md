---
name: kafka-events
description: >
  Add or modify Kafka producers, consumers and event contracts. Use when: publishing
  a domain event, writing a consumer, adding a topic, handling retries/DLQ, or when
  the user says "publish event", "kafka", "consumer", "event-driven", "async",
  "emit event". Use REST, not Kafka, when the caller needs an answer.
---

# Kafka Events

Reference: `docs/architecture/ARCHITECTURE.md` §17.

## The rule

> **REST when the caller cannot continue without the answer.
> Kafka when another service merely needs to react.**

Before adding an event, answer: *does anything wait for the result?* If yes, it is
REST. A Kafka event whose producer then polls for a result is RPC with worse failure
modes.

## Topics

| Topic | Key | Producers | Consumers |
|---|---|---|---|
| `organization.events` | `organizationId` | tenant | audit, user, subscription |
| `user.events` | `organizationId` | user, auth | audit, subscription |
| `subscription.events` | `organizationId` | subscription, user | audit, resource |
| `resource.events` | `organizationId` | resource | audit, subscription |
| `security.events` | `organizationId` or `'platform'` | all | audit |
| `*.dlq` | original key | retry handler | operator |

**Always key by `organizationId`.** A tenant's events land on one partition and stay
ordered, so counter reconciliation converges. Cross-tenant ordering is not required.

## Envelope

```ts
{
  eventId,        // uuid — consumer idempotency key
  eventType,
  eventVersion,
  organizationId, // also the partition key
  correlationId,  // propagated from the originating HTTP request
  causationId,
  actorUserId,
  occurredAt,
  payload,
}
```

## Producing

**Publish after commit, never inside a transaction:**

```ts
const events: DomainEvent[] = [];
await this.dataSource.transaction(async (manager) => {
  // ... writes; collect events in memory
});                                  // COMMIT
await this.publisher.publishAll(events);   // then publish
```

An event published inside a transaction that then rolls back is a lie. The crash
window between commit and publish is a known, documented gap (§17.5) with a stated
upgrade path to a real outbox table.

## Consuming

- **At-least-once** delivery — consumers **must** be idempotent.
- Dedupe via `consumed_events(event_id)` unique constraint; a duplicate insert means skip.
- **Manual offset commit after successful processing** — a crash mid-handler replays
  rather than skipping silently.
- Retry 3× with backoff (1s, 5s, 25s), then DLQ.
- **The base consumer opens an ALS tenant scope from `envelope.organizationId` before
  invoking the handler.** A handler never receives an unscoped payload. If you find
  yourself calling `als.run` inside a handler, the base class is being bypassed.

## Never use Kafka for

| Not for | Use instead | Why |
|---|---|---|
| Seat/storage limit enforcement | Postgres transaction + row lock | Kafka gives no transactional guarantee; the limit would become eventually consistent — that is the bug |
| Request/response | REST | RPC over a bus, with worse ergonomics |
| Onboarding saga steps | REST | Each step must know the previous succeeded |
| Reading another service's data | REST or a read model | Kafka notifies of change; it does not answer queries |

## Adding an event — checklist

- [ ] Nothing waits for the result (otherwise: REST)
- [ ] Contract in `libs/common`, versioned
- [ ] Keyed by `organizationId`
- [ ] Published **after** commit
- [ ] Consumer is idempotent via `event_id`
- [ ] Consumer opens tenant ALS from the envelope
- [ ] Retry + DLQ configured
- [ ] `correlationId` propagated
- [ ] audit-service consumes it if it is domain-significant
- [ ] Contract test covering producer ↔ consumer shape
