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

1. **PostgreSQL is the sole arbiter.** Not an in-memory counter, not an event handler, not application state.
2. **One transaction** spans the check and the write. A check outside the write's
   transaction is a TOCTOU bug.
3. **Pessimistic locking** (`SELECT … FOR UPDATE`), not optimistic retry.
4. **A `CHECK` constraint as backstop**, so the invariant survives a future code
   path that skips the lock.

## The canonical pattern

`backend/src/services/users.service.ts` `invite()`:

```ts
const invitationId = await transaction(async (tx) => {       // lib/tenant-db.ts — RLS-scoped
  // 1. Lock the subscription row FIRST — always the first lock taken (deadlock avoidance)
  const seat = await seats.lockForUpdate(tx, organizationId);
  //    models/subscription-seat.model.ts:
  //    SELECT used_seats, max_seats_snapshot FROM subscriptions
  //    WHERE organization_id = ${organizationId}::uuid FOR UPDATE

  // 2. Check the AUTHORITATIVE counter read under the lock.
  //    Do NOT recompute with count(*) on the hot path — used_seats IS the quantity
  //    the limit is defined on, and the CHECK constraint guards that same column.
  if (seat.usedSeats >= seat.maxSeatsSnapshot) {
    throw new PlanLimitExceededException({ limitType: 'seats', limit: seat.maxSeatsSnapshot,
      current: seat.usedSeats, planCode: 'unknown', activeUsers, pendingInvitations }, message);
  }

  // 3. Write + adjust the counter in the same transaction
  const invitation = await invitations.create(tx, organizationId, { ... });
  await seats.adjustUsedSeats(tx, organizationId, 1);
  return invitation.id;
});
// 4. Publish events AFTER commit — never inside
await publish(TOPICS.USER, { eventType: EVENT_TYPES.USER_INVITED, ... });
```

Storage is the same shape on `plan_limit_cache` (`resources.service.ts` `create()` /
`remove()`, `models/plan-limit-cache.model.ts`); a plan downgrade locks the subscription
row and checks usage against the **target** plan (`subscriptions.service.ts`
`changePlan()`). Prisma interactive transactions use `timeout: 30_000`, `maxWait: 10_000`
(`lib/tenant-db.ts`) so a queue of lock waiters does not time out at Prisma's 5 s default.
Use tagged `$queryRaw` for `FOR UPDATE` — Prisma's query API has no row-lock option.

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
| Revoke a pending invitation | −1 seat |
| Invitation expires (sweep) | −1 seat |
| Plan downgrade | Blocked if `used_seats > target plan limit` (D-Q4) — §19.10 |

A path that changes the sum **without taking the lock is a bug**, even if it appears to work.

**Known gaps kept from the old stack (ARCHITECTURE.md §0.5 — do not copy the pattern):**
the first admin created at onboarding is not counted in `used_seats`; the invitation
sweep currently releases nothing (its org listing is RLS-filtered to zero rows);
`updateRole` / `removeUser` count remaining admins without a lock (two concurrent
demotions can leave zero admins); refresh-token rotation takes no lock. Fixing any of
these is a behaviour change — call it out.

## Rules

| Rule | Why |
|---|---|
| Lock **before** counting | Counting first gives a stale value the lock was meant to prevent |
| Lock the **subscription row**, always first | Consistent lock ordering prevents deadlock |
| **No network calls inside the transaction** | No HTTP, no `publish()`, nothing but the Postgres statements. A held lock awaiting anything else stalls every request for that tenant |
| **Publish events after commit** | An event published inside a transaction that then rolls back is a lie |
| Counter column carries a `CHECK` | `CHECK (used_seats <= max_seats_snapshot)` — the backstop |
| Limit values are **denormalised** onto the row | A `CHECK` cannot span tables |
| Enforcement **never** reads an event-maintained counter | `subscriptions.used_storage_bytes` is display-only (maintained by `storage-reconciliation.handler.ts`); the storage limit is `plan_limit_cache` under lock |

## Forbidden approaches

| Approach | Why not |
|---|---|
| Redis distributed lock (Redlock) | Not correct under partition without fencing tokens; Postgres already handles this transactionally |
| Optimistic locking + retry | Retry storms under the 50-concurrent-request burst test |
| Event-driven / queued enforcement | Makes a synchronous decision asynchronous and best-effort; the caller needs a yes/no now |
| Application-level mutex / in-memory counter | Single-process only; breaks with two replicas (the throttler is per-process for exactly this reason — it is not a limit) |
| Check in one transaction, write in another | The TOCTOU bug this whole design exists to prevent |
| `count(*)` read outside the lock | Stale by definition |

## Rejection response

Must be specific and actionable — a generic error fails the requirement:

```
409 Conflict
{
  "statusCode": 409,
  "error": "PLAN_LIMIT_EXCEEDED",
  "message": "Your plan allows 5 seats. All 5 are held (3 users, 2 pending invitations). Remove a user or revoke a pending invitation before inviting another.",
  "details": { "limitType": "seats", "limit": 5, "current": 5, "planCode": "unknown",
               "activeUsers": 3, "pendingInvitations": 2 }
}
```

Throw `PlanLimitExceededException` (`lib/http-errors.ts`). Rollback is automatic: the
exception propagates out of the `transaction()` callback and Prisma rolls back.
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
model would test the mock, not the lock.

## Review checklist

- [ ] Check and write in **one** transaction
- [ ] `FOR UPDATE` on the subscription row, taken first
- [ ] Counter incremented in the same transaction
- [ ] `CHECK` constraint exists as backstop
- [ ] No network call inside the transaction
- [ ] Events published after commit
- [ ] 409 with a specific, actionable message and structured `details`
- [ ] Concurrent test present and not skipped
- [ ] Enforcement reads no event-derived or in-memory counter
