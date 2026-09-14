---
name: concurrency-safety
description: >
  Enforce correct plan-limit and counter behaviour under concurrent requests. Use
  when: implementing or changing any limit check (seats, storage, quotas), writing
  a transaction, adding a counter column, reviewing invite/create paths, or when
  the user says "plan limit", "concurrency", "race condition", "FOR UPDATE",
  "transaction", "locking", "quota". ALWAYS invoke before changing any code path
  that enforces a limit.
---

# Concurrency Safety — Plan Limits Under Load

Requirement: two simultaneous requests that each individually fit the remaining
limit must not both succeed. Reference: `docs/architecture/ARCHITECTURE.md` §19.

## The principles

1. **PostgreSQL is the sole arbiter.** Not Redis, not Kafka, not application state.
2. **One transaction** spans the check and the write. A check outside the write's
   transaction is a TOCTOU bug.
3. **Pessimistic locking** (`SELECT … FOR UPDATE`), not optimistic retry.
4. **A `CHECK` constraint as backstop**, so the invariant survives a future code
   path that skips the lock.

## The canonical pattern

```ts
await this.dataSource.transaction(async (manager) => {
  // 1. Lock the subscription row FIRST — always the first lock taken (deadlock avoidance)
  const sub = await manager.query(
    `SELECT used_seats, max_seats_snapshot FROM subs.subscriptions
     WHERE organization_id = $1 FOR UPDATE`,
    [orgId],
  );

  // 2. Check the AUTHORITATIVE counter read under the lock.
  //    Do NOT recompute with count(*) on the hot path — used_seats IS the quantity
  //    the limit is defined on, and the CHECK constraint guards that same column.
  if (sub.used_seats >= sub.max_seats_snapshot) {
    throw new PlanLimitExceededException({
      limitType: 'seats', limit: sub.max_seats_snapshot,
      current: sub.used_seats, planCode: sub.plan_code,
    });
  }

  // 4. Write + increment the counter in the same transaction
  await manager.save(User, newUser);
  await manager.increment(Subscription, { organizationId: orgId }, 'used_seats', 1);
});
// 5. Publish events AFTER commit — never inside
```

## What counts as a seat (D-Q1 / D-Q7)

**`subscriptions.used_seats` is the authoritative counter.** The invariant it must satisfy:

```
used_seats == active users + pending, unexpired invitations
```

Read `used_seats` under the lock — never recompute with `count(*)` on the hot path.
The `CHECK` constraint guards that same column, so the enforced quantity and the
constrained quantity are one thing, not two.

Every path that changes that sum takes the **same lock on the same subscription row**, so they
serialise against each other:

| Path | Effect |
|---|---|
| Invite a user | +1 seat (the pending invitation holds it) |
| Accept an invitation | Net 0 — invitation becomes a user |
| Remove a user | −1 seat |
| Invitation expires (sweep) | −1 seat |
| Plan downgrade | Blocked if `used_seats > target plan limit` (D-Q4) — §19.10 |

A path that changes the sum **without taking the lock is a bug**, even if it appears to work.

## Rules

| Rule | Why |
|---|---|
| Lock **before** counting | Counting first gives a stale value the lock was meant to prevent |
| Lock the **subscription row**, always first | Consistent lock ordering prevents deadlock |
| **No network calls inside the transaction** | No HTTP, no Kafka publish, no Redis. A held lock awaiting a network response stalls every request for that tenant |
| **Publish events after commit** | An event published inside a transaction that then rolls back is a lie |
| Counter column carries a `CHECK` | `CHECK (used_seats <= max_seats_snapshot)` — the backstop |
| Limit values are **denormalised** onto the row | A `CHECK` cannot span tables |
| Enforcement **never** reads Redis or a Kafka-derived counter | Those are display values and may lag |

## Forbidden approaches

| Approach | Why not |
|---|---|
| Redis distributed lock (Redlock) | Not correct under partition without fencing tokens; Postgres already handles this transactionally |
| Optimistic locking + retry | Retry storms under the 50-concurrent-request burst test |
| Kafka-serialised requests | Makes a synchronous decision asynchronous; the caller needs a yes/no now |
| Application-level mutex | Single-process only; breaks with two replicas |
| Check in one transaction, write in another | The TOCTOU bug this whole design exists to prevent |
| `count(*)` read outside the lock | Stale by definition |

## Rejection response

Must be specific and actionable — a generic error fails the requirement:

```
409 Conflict
{
  "statusCode": 409,
  "error": "PLAN_LIMIT_EXCEEDED",
  "message": "Your Free plan allows 5 users. You currently have 5. Upgrade to Pro to invite more.",
  "details": { "limitType": "users", "limit": 5, "current": 5, "planCode": "free" },
  "correlationId": "..."
}
```

Rollback is automatic: the exception propagates out of `dataSource.transaction()`.
There must be no partial state — no user row, no incremented counter.

## Required tests

Any new limit needs all three:

1. **Sequential** — fill to the cap, assert the next request gets 409.
2. **Concurrent pair** — 2 simultaneous requests with 1 seat free; assert exactly
   one 201 and one 409, and that the final count equals the limit exactly.
3. **Burst** — 50 simultaneous with 2 seats free; assert exactly 2 succeed.

For seats, see **ARCHITECTURE.md §28.2 (T3, variants V1-V7)** for the canonical test
list — do not maintain a second copy here.

Use Testcontainers. `FOR UPDATE` blocking behaviour cannot be mocked — a mocked
repository would test the mock, not the lock.

## Review checklist

- [ ] Check and write in **one** transaction
- [ ] `FOR UPDATE` on the subscription row, taken first
- [ ] Counter incremented in the same transaction
- [ ] `CHECK` constraint exists as backstop
- [ ] No network call inside the transaction
- [ ] Events published after commit
- [ ] 409 with a specific, actionable message and structured `details`
- [ ] Concurrent test present and not skipped
- [ ] Enforcement reads no Redis or event-derived counter
