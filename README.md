# Multi-Tenant Subscription Management

A POC demonstrating **structural tenant isolation**, enforced plan limits under real concurrency,
and self-service organisation onboarding.

> **Status: backend complete (7 services, 170 unit + 62 integration tests). Docker infrastructure
> complete — the full stack has been brought up and a real end-to-end signup verified against it.
> Two pre-existing DI defects in `libs/database` and `libs/kafka` currently stop the six
> database-owning services from booting; see "Known blocker" below. Frontend is a Vite scaffold.**

## The problem

A product serving several client organisations with no real wall between them: a query missing a
filter leaks one organisation's data into another's response, plan limits exist only as a number in
a spreadsheet nobody enforces, and onboarding a new client means an engineer creating rows by hand.

## The two hard cases

| # | Case | Answer |
|---|---|---|
| **H1** | A user of Org A requests, by ID, a resource belonging to Org B — with a well-formed request, from an endpoint whose author forgot to scope the query | PostgreSQL **Row-Level Security**. The filter is not in the application at all, so it cannot be forgotten. A careless `SELECT * FROM resources` returns only the caller's tenant rows |
| **H2** | Two invites arrive simultaneously; each fits the remaining seat limit, together they exceed it | One **transaction** with `SELECT … FOR UPDATE` on the subscription row, plus a `CHECK` constraint as an independent backstop. Not Redis, not Kafka |

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture/ARCHITECTURE.md) | The full technical design — 32 sections. **Start here** |
| [POC Brief](docs/architecture/POC-BRIEF.md) | The source requirements |

Sections worth reading first: **§13 Tenant Isolation** and **§19 Concurrency** — the rest of the
architecture is subordinate to those two.

## Stack

**Backend** — NestJS microservices · TypeScript · **TypeORM** (the only permitted ORM) ·
PostgreSQL · Kafka (KRaft) · Redis · JWT + Passport + Argon2 · CASL · **pnpm**

**Frontend** — React · TypeScript · Vite · Tailwind · TanStack Query + Table · React Hook Form +
Zod · Vitest + RTL · **pnpm**

Seven services: `api-gateway`, `auth-service`, `tenant-service`, `user-service`,
`subscription-service`, `resource-service`, `audit-service`. Each owns its data; §7 explains why
each exists and §14 who owns what.

## Repository layout

```
backend/     NestJS monorepo — pnpm workspace   (7 services, complete)
frontend/    React SPA                          (Vite scaffold only)
docker/      postgres init + one-shot migrator
docs/        architecture + brief
.claude/     skills and agents governing implementation
```

## Getting started

```bash
cp .env.example .env     # edit the secrets — see the notes in the file
docker compose up
```

No manual setup beyond the documented `.env` — that is a requirement of the POC, not an
aspiration. There is no separate migration step and no seeding step: a one-shot `migrator`
container runs every service's migrations as `app_migrator`, seeds the platform admin, and exits
before any application service starts (`depends_on: condition: service_completed_successfully`).

Ten containers, **one published port**: only `api-gateway` is reachable from the host, on
<http://localhost:3000>. Postgres, Redis, Kafka and the six other services are on an internal
bridge network with no port mapping at all — §10.5 layer 1, expressed as configuration.
(§27.1 describes eleven containers and two ports; the eleventh is `frontend`, which is still a
bare Vite scaffold and is deliberately not in `docker-compose.yml` yet.)

### Seed data

- **Three plans** (free/pro/enterprise) — inserted by subscription-service's own migration, so
  they are idempotent via the migrations ledger and exist before the FK from `subs.subscriptions`
  can ever be satisfied.
- **One platform admin** — a `credentials` row with `organization_id` NULL, which is the single
  column that makes `AuthService.resolveRoles` return `PLATFORM_ADMIN`. Seeded from
  `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`; leave the password empty to skip it.

### Running migrations outside Docker

Each database-owning service has a CLI `DataSource` at `src/database/data-source.ts` and its own
scripts. These connect as `app_migrator` (DDL rights), never as the runtime `app_user`:

```bash
cd backend && pnpm --filter user-service migration:run    # also :revert, :show
```

user-service's core_db migrations must run **before** subscription-service's — the latter `ALTER`s
a table the former creates (§32.3). `docker/migrator/run-migrations.sh` encodes that ordering.

> **Known blocker (not yet fixed):** the six database-owning services currently crash on boot with
> `UnknownDependenciesException` from two pre-existing DI defects in `libs/database` and
> `libs/kafka`. `api-gateway` is unaffected. See the note at the top of
> `docker/migrator/run-migrations.sh` and the project handover for the diagnosis — the
> infrastructure in this section is verified working once those two library modules are corrected.

## Conventions

Implementation is governed by the skills in [.claude/skills/](.claude/skills/). The rules that
matter most:

- **TypeORM only.** Never Prisma, Sequelize, Drizzle or Mongoose.
- **pnpm only.** Never `npm install` or `yarn add`.
- Every tenant table enables **and forces** RLS in the migration that creates it.
- Limit checks are one Postgres transaction with a row lock — never Redis, never Kafka.
- Tenant isolation is never enforced by a CASL rule or a hand-written `WHERE` clause.
