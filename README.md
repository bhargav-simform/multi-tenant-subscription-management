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
| [backend/README.md](backend/README.md) | Backend tech stack, setup, per-service commands, migrations, testing |
| [frontend/README.md](frontend/README.md) | Frontend tech stack, setup, dev server, build, testing |

Sections worth reading first: **§13 Tenant Isolation** and **§19 Concurrency** — the rest of the
architecture is subordinate to those two.

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| Backend framework | NestJS (`@nestjs/core`) | 12.0.1 |
| Language (backend) | TypeScript | 5.9.3 |
| ORM | TypeORM | 1.1.1 |
| Database | PostgreSQL | 17 (alpine) |
| Message broker | Apache Kafka (KRaft mode, no ZooKeeper) | 4.0.0 |
| Cache / idempotency store | Redis | 8 (alpine) |
| Authentication | JWT (`@nestjs/jwt`) + Passport + Argon2 | 12.0.1 / 0.7.0 / 0.45.1 |
| Authorization | CASL (`@casl/ability`) | 7.0.1 |
| Logging | Pino (`nestjs-pino`) | 5.1.0 |
| Frontend framework | React | 19.3.0 |
| Language (frontend) | TypeScript | 5.9.3 |
| Build tool | Vite | 7.3.6 |
| Styling | Tailwind CSS | 4.3.3 |
| Server state | TanStack Query | 5.103.1 |
| Tables | TanStack Table | 8.21.3 |
| Forms | React Hook Form + Zod | 7.88.0 / 4.6.5 |
| Routing | React Router | 7.18.4 |
| HTTP client | Axios | 1.20.0 |
| Backend test runner | Jest + Testcontainers | 30.5.1 |
| Frontend test runner | Vitest + React Testing Library | 3.2.7 / 16.3.3 |
| Package manager | pnpm | 10.32.1 |
| Runtime | Node.js | 22.18.0 |
| Containerisation | Docker Compose | — |

Seven backend services: `api-gateway`, `auth-service`, `tenant-service`, `user-service`,
`subscription-service`, `resource-service`, `audit-service`. Each owns its data; §7 of the
architecture doc explains why each exists and §14 who owns what.

## Repository layout

```
backend/     NestJS monorepo — pnpm workspace   (7 services, complete)
frontend/    React SPA — pnpm, Vite, Tailwind    (all screens, own Dockerfile)
docker/      postgres init + one-shot migrator
docs/        architecture + brief
```

## Prerequisites

- **Docker** `>= 29.4.1` and **Docker Compose** `>= v5.1.3` — this is the only way this project is
  intended to run. There is no host-level requirement to install Node, pnpm, Postgres, Redis or
  Kafka yourself; every one of those runs inside a container.
- For working on the backend or frontend source directly (outside Docker — see each package's own
  README), you additionally need **Node.js >= 22.18.0** and **pnpm >= 10.32.1**.

## Getting started

The whole stack, the intended way to run this project — one command, no manual setup beyond the
`.env` file:

```bash
cp .env.example .env     # edit the secrets — see the notes in the file
docker compose up
```

That single command builds every image (first run only — subsequent runs reuse the cache) and
starts all eleven containers in dependency order.

## Docker

### Full stack

```bash
docker compose up            # build (if needed) and start every container, logs attached
docker compose up -d         # same, detached
docker compose ps            # status + health of every container
docker compose down          # stop and remove all containers (keeps the postgres volume)
docker compose down -v       # same, and also drop the postgres volume (fresh DB next run)
```

There is no separate migration step and no seeding step: a one-shot `migrator` container runs
every service's migrations as `app_migrator`, seeds the platform admin, and exits before any
application service starts (`depends_on: condition: service_completed_successfully`).

Eleven containers, **two published ports**: `api-gateway` on <http://localhost:3000> and
`frontend` on <http://localhost:5178>. Postgres, Redis, Kafka and the six non-gateway backend
services are on an internal bridge network with no port mapping at all. `frontend` isn't on that
internal network either: its compiled JS runs in the browser and calls `api-gateway`'s
host-published port directly, so it has no need for a container-to-container path to any backend
service.

| Container | Image / build | Published port |
|---|---|---|
| `postgres` | `postgres:17-alpine` | internal only |
| `redis` | `redis:8-alpine` | internal only |
| `kafka` | `bitnamilegacy/kafka:4.0.0-debian-12-r10` (KRaft mode) | internal only |
| `migrator` | `backend/Dockerfile` (one-shot, exits on success) | — |
| `api-gateway` | `backend/Dockerfile` | `127.0.0.1:3000` |
| `auth-service` | `backend/Dockerfile` | internal only |
| `tenant-service` | `backend/Dockerfile` | internal only |
| `user-service` | `backend/Dockerfile` | internal only |
| `subscription-service` | `backend/Dockerfile` | internal only |
| `resource-service` | `backend/Dockerfile` | internal only |
| `audit-service` | `backend/Dockerfile` | internal only |
| `frontend` | `frontend/Dockerfile` (nginx serving the static build) | `127.0.0.1:5178` |

### Rebuilding after a code change

```bash
docker compose build <name>              # rebuild one image
docker compose up -d --build <name>      # rebuild and restart one container in one step
docker compose logs -f <name>            # tail one container's logs
```

`<name>` is any container from the table above, e.g. `docker compose up -d --build user-service`.

A change under `backend/libs/` is shared by six services (everything except `frontend`) — rebuild
and restart all of them, not just the one you edited directly:

```bash
docker compose build audit-service auth-service resource-service subscription-service tenant-service user-service
docker compose up -d audit-service auth-service resource-service subscription-service tenant-service user-service
```

### Seed data

- **Three plans** (free/pro/enterprise) — inserted by subscription-service's own migration, so
  they are idempotent via the migrations ledger and exist before the FK from `subs.subscriptions`
  can ever be satisfied.
- **One platform admin** — a `credentials` row with `organization_id` NULL, which is the single
  column that makes `AuthService.resolveRoles` return `PLATFORM_ADMIN`. Seeded from
  `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` (defaults to `admin@platform.local` in
  `.env.example` — set your own password in `.env` before first `docker compose up`, or leave the
  password empty to skip the seed entirely). Log in with it at `/login` like any other account,
  then visit `/admin/organizations` — the platform-admin shell is a structurally separate part of
  the SPA with no access to any organization's actual users or resources (§12.3), only
  organization/plan/usage metadata and the cross-tenant security event log at `/admin/security`.

## Environment variables

All of `.env.example`, grouped as the file itself groups them. Every backend service reads the
same `.env` — NestJS's `ConfigService` picks out only what each service asks for.

| Variable | Description |
|---|---|
| `NODE_ENV` | `development` \| `production` |
| `LOG_LEVEL` | Pino log level, e.g. `debug` |
| `POSTGRES_HOST` / `POSTGRES_PORT` | Postgres connection target (container name inside Docker) |
| `POSTGRES_SUPERUSER` / `POSTGRES_SUPERUSER_PASSWORD` | Used once, by `docker/postgres/init.sh`, to create the app roles below |
| `APP_DB_USER` / `APP_DB_PASSWORD` | Runtime role every service connects as — `NOBYPASSRLS`, enforced at boot |
| `MIGRATOR_DB_USER` / `MIGRATOR_DB_PASSWORD` | DDL role the one-shot `migrator` container connects as |
| `TENANT_DB_NAME` / `AUTH_DB_NAME` / `CORE_DB_NAME` / `RESOURCE_DB_NAME` / `AUDIT_DB_NAME` | One physical database per bounded context (`CORE_DB_NAME` is shared by user-service and subscription-service, in separate schemas) |
| `REDIS_HOST` / `REDIS_PORT` | Redis connection target |
| `KAFKA_BROKERS` / `KAFKA_CLIENT_ID_PREFIX` | Kafka connection target and client ID prefix |
| `JWT_SECRET` / `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | Access-token signing secret and TTLs |
| `INTERNAL_SIGNING_SECRET` / `INTERNAL_CONTEXT_TTL_SECONDS` | Signs the internal service-to-service context header — **must differ** from `JWT_SECRET` |
| `CORS_ORIGINS` | Allowed browser origin(s) on `api-gateway` — must match wherever `frontend` is actually served from |
| `THROTTLE_TTL` / `THROTTLE_LIMIT` / `THROTTLE_AUTH_LIMIT` | Rate limiting window, general limit, and the stricter limit on `/auth/login` + `/onboarding/signup` |
| `ARGON2_MEMORY_COST` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` | Password hashing cost parameters |
| `AUTH_SERVICE_URL` / `TENANT_SERVICE_URL` / `USER_SERVICE_URL` / `SUBSCRIPTION_SERVICE_URL` / `RESOURCE_SERVICE_URL` / `AUDIT_SERVICE_URL` | Internal, container-to-container base URLs for inter-service calls |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | Seeds the one platform-admin credential on first migrator run; leave the password empty to skip the seed |
| `VITE_API_BASE_URL` | Frontend build-time value — the origin the SPA's compiled JS calls |

`PORT` is not set in `.env` at all — it's fixed per service in `docker-compose.yml`'s
`environment:` block, since seven services cannot share one port value.

## Conventions

- **TypeORM only.** Never Prisma, Sequelize, Drizzle or Mongoose.
- **pnpm only.** Never `npm install` or `yarn add`.
- Every tenant table enables **and forces** RLS in the migration that creates it.
- Limit checks are one Postgres transaction with a row lock — never Redis, never Kafka.
- Tenant isolation is never enforced by a CASL rule or a hand-written `WHERE` clause.
