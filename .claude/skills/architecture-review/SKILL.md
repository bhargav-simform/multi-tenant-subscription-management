---
name: architecture-review
description: >
  Check a change against the approved architecture and flag drift. Use when:
  reviewing a diff or PR, before merging a feature, when adding a module, middleware
  or dependency, when unsure whether something belongs in a given layer, or when the
  user says "review this", "does this fit the architecture", "architecture check",
  "is this the right module". Invoke at the end of any multi-file change.
---

# Architecture Review

Check a change against `docs/architecture/ARCHITECTURE.md` — **§0 describes the current
Express + Prisma monolith and overrides later sections where they conflict.** Report
violations with the section they breach. Do not approve a change that breaks a hard
rule — say what must change instead.

## Hard rules — a violation blocks the change

| # | Rule | Section |
|---|---|---|
| 1 | **Prisma is the ORM; schema changes are hand-written SQL migrations.** No `prisma migrate dev` / `db push`; no second ORM (TypeORM, Sequelize, Drizzle, Mongoose) | §0.1, §14.5, §15 |
| 2 | **pnpm only.** No `npm install` or `yarn add` | §5.1 |
| 3 | Tenant tables have RLS **enabled and forced**, `NULLIF` policy with `USING` + `WITH CHECK`, explicit per-table grants — in the creating migration | §13.5, §14.5 |
| 4 | No new tenant-isolation bypass (flag, admin pool, BYPASSRLS login role). Only `runGlobal()` and `app_rls_bypass`-owned SECURITY DEFINER id/boolean lookups | §13.6 |
| 5 | Tenant data is accessed only inside a `lib/tenant-db.ts` transaction | §0.2, §15.3 |
| 6 | Limit enforcement is a Postgres transaction + `FOR UPDATE` on the counter row + `CHECK` — never an in-memory counter or an event handler | §19 |
| 7 | `organizationId` only from the verified token via `contextStore` — never body, query, path or client header; only `middlewares/authenticate.ts` reads identity from `req` | §13.3 |
| 8 | Controllers never touch models/Prisma; models never read `contextStore`/`req` or open transactions | §21.3 |
| 9 | No network call inside a transaction; `publish()` only after commit | §15.5, §17.5 |
| 10 | Correctness never depends on an event handler succeeding (best-effort, no retry) | §0.4, §17 |
| 11 | Cross-tenant access returns 404, never 403 | §13.9 |
| 12 | Errors via `lib/http-errors.ts`; public response bodies/statuses unchanged unless the change is explicitly an API change (the frontend depends on them) | §0 |
| 13 | New public (`anonymous`) route requires a §11.5 justification; unauthenticated writes go in the strict throttle bucket | §11.5 |
| 14 | `assertRlsSafeRole()` stays in boot; the app connects as `app_user` | §13.8 |
| 15 | No Redux/Zustand/MobX on the frontend | §4 |
| 16 | No Kubernetes, Prometheus, Elasticsearch, message broker or cache added without a documented reason | §4, §27.4 |

## Layer placement

```
Route        path + middleware chain (throttle → authenticate|anonymous → [requirePlatformAdmin] → authorize → validate)
Controller   HTTP only — req in, view out, status code
Service      business rules, transaction boundary, limit checks, publish() after commit
Model        Prisma / tagged raw SQL for one table; takes Tx; BigInt → number
View         domain → response body
```

Common misplacements:
- Business rules or a transaction in a controller → service
- `getPrisma()` or a Prisma query in a service or controller → model, inside a tenant-db transaction
- `req.user` / `req.headers` read outside `authenticate.ts` → `contextStore`
- A model calling `contextStore` → pass the value in from the service
- `res.status(4xx).json(...)` by hand → throw an `HttpException` subclass

## Module placement

The old services are now file groups. Put new behaviour with its owner:

| If it... | It belongs in |
|---|---|
| sees a password or mints/revokes a token | `auth.service`, `credentials.service`, `token-*.service` |
| concerns organisations or onboarding | `organizations.*`, `onboarding.*` |
| concerns membership, roles, invitations, seats | `users.*`, `users-read.*`, `invitations.*`, `subscription-seat.model` |
| concerns plans, subscriptions, usage | `subscriptions.*`, `plans.*`, `usage.*` |
| is tenant business content | `resources.*` |
| records what happened | an event → `events/handlers/audit-sink` / `security-events` (never a write route) |

Cross-module calls go through the other module's **service**, not its models, so the
old boundaries stay usable seams.

## Sync vs async

> A direct function call when the caller needs the answer.
> An event when another module merely needs to react.

Flag: an event whose publisher then depends on the handler's effect (make it a call, or
accept best-effort explicitly), and a synchronous call for something nobody waits on
(audit especially).

## Dependency additions

Every new dependency needs a stated reason. Reject: a second ORM, a broker or cache
without a documented need, a client state library, a component library, `bcrypt`
(Argon2 is specified), `moment`, Passport/Nest (not used).

## Review output

```
BLOCKING   §13.5  widgets table missing FORCE ROW LEVEL SECURITY
BLOCKING   §19    seat check outside the transaction — TOCTOU
BLOCKING   §15.3  resources.service calls getPrisma().resource.findMany directly
WARNING    §21.3  users.service imports resource.model — call resources.service instead
NOTE       §29    list endpoint uses OFFSET; keyset is the standard here
```

Cite the section. A finding without one is an opinion, not a review.
