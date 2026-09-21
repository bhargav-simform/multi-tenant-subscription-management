# Multi-Tenant Subscription Management

A POC demonstrating **structural tenant isolation**, enforced plan limits under real concurrency,
and self-service organisation onboarding.

> **Status: full stack verified end to end.** Backend: 7 services, 196 unit tests passing. Docker
> infrastructure complete — `docker compose up` brings up all eleven containers healthy, and a real
> signup → invite → accept → login flow has been exercised against the running stack. Frontend is a
> built React SPA (login/signup, dashboard, resources incl. the H1 cross-tenant detail view, user
> management, plan & usage, audit log, and a structurally separate platform-admin shell) with its
> own Dockerfile, wired into `docker-compose.yml` as the eleventh container.

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
| [backend/README.md](backend/README.md) | Backend-only setup, per-service commands, migrations, testing |
| [frontend/README.md](frontend/README.md) | Frontend-only setup, dev server, build, testing |

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
frontend/    React SPA — pnpm, Vite, Tailwind    (all screens, own Dockerfile)
docker/      postgres init + one-shot migrator
docs/        architecture + brief
.claude/     skills and agents governing implementation
```

## Getting started

The whole stack, the intended way to run this project — one command, no manual setup beyond the
`.env` file:

```bash
cp .env.example .env     # edit the secrets — see the notes in the file
docker compose up
```

There is no separate migration step and no seeding step: a one-shot `migrator` container runs
every service's migrations as `app_migrator`, seeds the platform admin, and exits before any
application service starts (`depends_on: condition: service_completed_successfully`).

Eleven containers, **two published ports**, matching §27.1: `api-gateway` on
<http://localhost:3000> and `frontend` on <http://localhost:5178>. Postgres, Redis, Kafka and the
six non-gateway backend services are on an internal bridge network with no port mapping at all —
§10.5 layer 1, expressed as configuration. `frontend` isn't on that internal network at all: its
compiled JS runs in the browser and calls `api-gateway`'s host-published port directly, so it has
no need for a container-to-container path to any backend service.

### Root-level commands

Everything below runs from the repository root, against the full stack. For commands scoped to
just one half of the codebase (per-service backend commands, or the frontend dev server), see
[backend/README.md](backend/README.md) and [frontend/README.md](frontend/README.md).

```bash
docker compose up                    # build (if needed) and start every container
docker compose up -d                 # same, detached
docker compose up -d --build <name>  # rebuild and restart one container after a code change
docker compose ps                    # status + health of every container
docker compose logs -f <name>        # tail one service's logs
docker compose down                  # stop and remove all containers (keeps the postgres volume)
docker compose down -v               # same, and also drop the postgres volume (fresh DB next run)
```

`<name>` is any service from `docker-compose.yml`: `postgres`, `redis`, `kafka`, `migrator`,
`api-gateway`, `auth-service`, `tenant-service`, `user-service`, `subscription-service`,
`resource-service`, `audit-service`, `frontend`.

### Seed data

- **Three plans** (free/pro/enterprise) — inserted by subscription-service's own migration, so
  they are idempotent via the migrations ledger and exist before the FK from `subs.subscriptions`
  can ever be satisfied.
- **One platform admin** — a `credentials` row with `organization_id` NULL, which is the single
  column that makes `AuthService.resolveRoles` return `PLATFORM_ADMIN`. Seeded from
  `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`; leave the password empty to skip it.

## Conventions

Implementation is governed by the skills in [.claude/skills/](.claude/skills/). The rules that
matter most:

- **TypeORM only.** Never Prisma, Sequelize, Drizzle or Mongoose.
- **pnpm only.** Never `npm install` or `yarn add`.
- Every tenant table enables **and forces** RLS in the migration that creates it.
- Limit checks are one Postgres transaction with a row lock — never Redis, never Kafka.
- Tenant isolation is never enforced by a CASL rule or a hand-written `WHERE` clause.
