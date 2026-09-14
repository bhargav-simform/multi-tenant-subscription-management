---
name: architecture-review
description: >
  Check a change against the approved architecture and flag drift. Use when:
  reviewing a diff or PR, before merging a feature, when adding a service or
  dependency, when unsure whether something belongs in a given layer, or when the
  user says "review this", "does this fit the architecture", "architecture check",
  "is this the right service". Invoke at the end of any multi-file change.
---

# Architecture Review

Check a change against `docs/architecture/ARCHITECTURE.md`. Report violations with
the section they breach. Do not approve a change that breaks a hard rule — say what
must change instead.

## Hard rules — a violation blocks the change

| # | Rule | Section |
|---|---|---|
| 1 | **TypeORM is the only ORM.** No Prisma, Sequelize, Drizzle, Mongoose | §5 |
| 2 | **pnpm only.** No `npm install` or `yarn add` | §5.1 |
| 3 | Tenant tables have RLS **enabled and forced**, with `USING` + `WITH CHECK` | §13.5 |
| 4 | No tenant-isolation bypass (`skipRls`, `asSystem()`, admin pool) | §13.6 |
| 5 | Limit enforcement is a Postgres transaction + row lock — never Redis or Kafka | §19 |
| 6 | No business logic, database or entity in `api-gateway` | §10.3 |
| 7 | No `@Entity()` in `libs/` | §15.2 |
| 8 | An app never imports from another app | §21.3 |
| 9 | No cross-service DB access except the documented `subs.subscriptions` grant | §14.2 |
| 10 | `synchronize: false` everywhere | §15.1 |
| 11 | No network call inside a transaction | §15.5 |
| 12 | Events published after commit, never inside | §17.5 |
| 13 | `orgId` only from the signed token — never body, query, path or client header | §13.3 |
| 14 | Cross-tenant access returns 404, never 403 | §13.9 |
| 15 | No Redux/Zustand/MobX on the frontend | §4 |
| 16 | No Kubernetes, Prometheus, Elasticsearch, RabbitMQ, ZooKeeper | §4, §27.4 |

## Layer placement

```
Controller           HTTP only — route, DTO in, DTO out. No business rules
Application Service  Orchestration, transaction boundaries, event collection
Domain               Pure rules. No framework imports, no I/O
Repository Interface Declared by the domain
TypeORM Repository   Infrastructure. Extends TenantRepository
```

Common misplacements to look for:
- Business rules in a controller → move to the application service
- TypeORM imported by domain code → the domain declares an interface instead
- A transaction opened in a controller → belongs in the application service
- `new SomeService()` anywhere → use DI (§20)

## Service boundary questions

When a change adds behaviour, ask where it belongs:

| If it... | It belongs in |
|---|---|
| sees a password or mints a token | auth-service |
| concerns organisations or onboarding | tenant-service |
| concerns membership, roles, invitations | user-service |
| concerns plans, limits, usage | subscription-service |
| is tenant business content | resource-service |
| records what happened | audit-service (via Kafka only) |
| needs a domain concept to decide | **not** api-gateway |

Adding an eighth service requires a documented reason meeting the §7.3 bar. Default
to extending an existing service.

## Sync vs async

> REST when the caller cannot continue without the answer.
> Kafka when another service merely needs to react.

Flag: a Kafka event whose producer then waits for a result (that is RPC — use REST),
and a REST call for something nobody is waiting on (audit especially — §9.3).

## Dependency additions

Every new dependency needs a stated reason (§23 MVP rule). Reject: a second ORM, a
second message broker, a client state library, a component library, `bcrypt`
(Argon2 is specified), `moment`.

## Review output

Report as:

```
BLOCKING   §13.5  widgets table missing FORCE ROW LEVEL SECURITY
BLOCKING   §19    seat check outside the transaction — TOCTOU
WARNING    §21.3  user-service imports a type from resource-service — move to libs/common
NOTE       §29    list endpoint uses OFFSET; keyset is the standard here
```

Cite the section. A finding without one is an opinion, not a review.
