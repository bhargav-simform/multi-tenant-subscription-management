# Multi-Tenant Subscription Management

A POC demonstrating **structural tenant isolation**, enforced plan limits under real concurrency,
and self-service organisation onboarding.

> **Status.** The backend is **one Express 5 + Prisma 7 process** (an MVC monolith) against **one
> PostgreSQL database**. It replaced an earlier NestJS 7-microservice / 5-database / Kafka + Redis
> implementation with identical external behaviour: a 99-step black-box HTTP diff against the old
> stack showed zero differences in paths, statuses or bodies. `docker compose up` brings up four
> containers (postgres, a one-shot migrator, backend, frontend). The frontend is a built React SPA
> (login/signup, dashboard, resources incl. the H1 cross-tenant detail view, user management, plan &
> usage, audit log, and a structurally separate platform-admin shell).

## The problem

A product serving several client organisations with no real wall between them: a query missing a
filter leaks one organisation's data into another's response, plan limits exist only as a number in
a spreadsheet nobody enforces, and onboarding a new client means an engineer creating rows by hand.

## The two hard cases

| # | Case | Answer |
|---|---|---|
| **H1** | A user of Org A requests, by ID, a resource belonging to Org B — with a well-formed request, from an endpoint whose author forgot to scope the query | PostgreSQL **Row-Level Security**. The filter is not in the application at all, so it cannot be forgotten. A careless `SELECT * FROM resources` returns only the caller's tenant rows |
| **H2** | Two invites arrive simultaneously; each fits the remaining seat limit, together they exceed it | One **transaction** with `SELECT … FOR UPDATE` on the subscription row, plus a `CHECK` constraint as an independent backstop. No cache, no queue |

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture/ARCHITECTURE.md) | The technical design. Read **"Current implementation"** at the top first — later sections describe the original microservice design and are marked where superseded |
| [Walkthrough](WALKTHROUGH.md) | A narrative tour of how isolation, locking and security actually work in the code |
| [POC Brief](docs/architecture/POC-BRIEF.md) | The source requirements |
| [backend/README.md](backend/README.md) | Backend layout, scripts, migrations, testing |
| [frontend/README.md](frontend/README.md) | Frontend tech stack, setup, dev server, build, testing |

Sections worth reading first: **§13 Tenant Isolation** and **§19 Concurrency** — the rest of the
architecture is subordinate to those two, and both still hold unchanged in the monolith.

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| Backend framework | Express | 5.2 |
| Language (backend) | TypeScript | 5.9 |
| ORM | Prisma (`prisma-client` generator + `@prisma/adapter-pg`) | 7.10 |
| Database | PostgreSQL, with Row-Level Security | 17 (alpine) |
| Authentication | `jsonwebtoken` + Argon2 | 9.0 / 0.45 |
| Authorization | CASL (`@casl/ability`) | 7.0 |
| Validation | class-validator + class-transformer | 0.15 / 0.5 |
| Logging | Pino (`pino-http`) | 10.3 / 11.0 |
| Scheduling | node-cron (invitation sweep, denylist purge) | 4.6 |
| Frontend framework | React | 19.3.0 |
| Language (frontend) | TypeScript | 5.9.3 |
| Build tool | Vite | 7.3.6 |
| Styling | Tailwind CSS | 4.3.3 |
| Server state | TanStack Query | 5.103.1 |
| Tables | TanStack Table | 8.21.3 |
| Forms | React Hook Form + Zod | 7.88.0 / 4.6.5 |
| Routing | React Router | 7.18.4 |
| HTTP client | Axios | 1.20.0 |
| Backend test runner | Jest + Supertest + Testcontainers | 30.5 / 7.3 / 12.1 |
| Frontend test runner | Vitest + React Testing Library | 3.2.7 / 16.3.3 |
| Package manager | pnpm | 10.32.1 |
| Runtime | Node.js | >= 22 |
| Containerisation | Docker Compose | — |

There is **no message broker and no cache**. Domain events are dispatched on an in-process bus,
the logout denylist is a Postgres table, and rate limiting is an in-memory fixed window.

## Architecture in one screen

```
browser ──► backend :3000  (Express, one process)
             helmet → CORS allowlist → JSON → correlation id → pino-http
             → per route: throttle → authenticate | anonymous → [requirePlatformAdmin]
                          → authorize (CASL) → validate (DTO) → controller
             controller → service → model (Prisma, inside a tenant-scoped transaction)
             service ──publish() after commit──► in-process event handlers
                                                 (first admin, plan_limit_cache, storage
                                                  counter, audit & security sinks)
             ▼
         PostgreSQL app_db (schema public, FORCE RLS on every tenant table)
```

- **Tenant isolation** — `lib/tenant-db.ts` opens a Prisma interactive transaction and runs
  `set_config('app.current_org', <org>, true)` as its first statement. RLS policies on every tenant
  table filter by that setting. The org comes only from the verified JWT, held in an
  `AsyncLocalStorage` context (`lib/context-store.ts`).
- **Database roles** — `app_migrator` (DDL, migrator only), `app_user` (DML, `NOBYPASSRLS`; the
  backend refuses to boot otherwise), `app_rls_bypass` (`NOLOGIN`, owns the narrow
  `SECURITY DEFINER` lookup functions).
- **Plan limits** — seats lock the `subscriptions` row, storage locks the `plan_limit_cache` row,
  both `FOR UPDATE` in one transaction with the write; `CHECK` constraints backstop both.
- **Events** — services call `publish()` after commit; handlers run in-process and are awaited
  before the response is sent. Handler failures are logged and swallowed; there is no retry/DLQ.

## Repository layout

```
backend/     Express + Prisma MVC monolith — pnpm
frontend/    React SPA — pnpm, Vite, Tailwind (own Dockerfile)
docker/      postgres init script + one-shot migrator entrypoint
docs/        architecture + brief
```

## Prerequisites

- **Docker** and **Docker Compose** — the intended way to run the project. Nothing else needs to be
  installed on the host.
- For working on source outside Docker (see each package's README): **Node.js >= 22** and
  **pnpm >= 10.32.1**.

## Getting started

```bash
cp .env.example .env     # edit the secrets — see the notes in the file
docker compose up
```

That builds the images (first run only) and starts the four containers in dependency order.

> **Upgrading an existing checkout from the microservice stack?** The old `docker/postgres/init.sh`
> created five databases and no `app_db`. Postgres only runs init scripts on an **empty** volume, so
> the new stack will fail against the old one. Run `docker compose down -v` once (this **destroys
> all local data**) before the first `docker compose up`. Also replace your `.env` from the new
> `.env.example` — the Kafka, Redis, internal-signing and per-service URL variables are gone and
> the database/throttle variables changed.

## Docker

```bash
docker compose up            # build (if needed) and start every container, logs attached
docker compose up -d         # same, detached
docker compose ps            # status + health of every container
docker compose down          # stop and remove containers (keeps the postgres volume)
docker compose down -v       # same, and drop the postgres volume (fresh DB next run)
docker compose up -d --build backend   # rebuild and restart the backend after a code change
docker compose logs -f backend
```

There is no manual migration or seed step: the one-shot `migrator` container runs
`prisma migrate deploy` as `app_migrator`, seeds the platform admin, and exits; the backend waits on
`condition: service_completed_successfully`.

| Container | Image / build | Published port |
|---|---|---|
| `postgres` | `postgres:17-alpine` | internal only |
| `migrator` | `backend/Dockerfile.migrator` (one-shot, exits on success) | — |
| `backend` | `backend/Dockerfile` | `127.0.0.1:3000` |
| `frontend` | `frontend/Dockerfile` (nginx serving the static build) | `127.0.0.1:5178` |

Health: `GET /api/v1/health` (liveness, `{status}`) and `GET /api/v1/health/ready`
(`{status, database}`, used by the compose healthcheck).

### Seed data

- **Three plans** (free/pro/enterprise) — inserted by the migration itself
  (`backend/prisma/migrations/0001_init/migration.sql`).
- **One platform admin** — a `credentials` row with `organization_id` NULL, which is the single
  column that makes login return the `platform_admin` role. There is no `users` row. Seeded from
  `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`; leave the password empty to skip. Log in at
  `/login`, then visit `/admin/organizations` — the platform-admin shell sees only organisation,
  plan and usage metadata and the security event log, never tenant users or resources.

## Environment variables

Exactly the variables in `.env.example`, grouped as the file groups them. The backend reads them
through `backend/src/config/env.ts`; a local (non-Docker) run loads `backend/.env`, then the
repo-root `.env`.

| Variable | Description |
|---|---|
| `NODE_ENV` | `development` \| `production` |
| `LOG_LEVEL` | Pino log level, e.g. `debug` |
| `POSTGRES_HOST` / `POSTGRES_PORT` | Postgres connection target (`postgres` inside Docker) |
| `POSTGRES_SUPERUSER` / `POSTGRES_SUPERUSER_PASSWORD` | Used only by the postgres container and `docker/postgres/init.sh` to create the database and roles |
| `DB_NAME` | The one application database (`app_db`) |
| `APP_DB_USER` / `APP_DB_PASSWORD` | Runtime role the backend connects as — DML only, `NOBYPASSRLS`, checked at boot |
| `MIGRATOR_DB_USER` / `MIGRATOR_DB_PASSWORD` | DDL role the one-shot `migrator` container connects as |
| `DATABASE_URL` / `MIGRATOR_DATABASE_URL` | Optional (commented out); override the URLs otherwise assembled from the values above |
| `JWT_SECRET` / `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | Token signing secret and TTLs (refresh TTL must be whole days, e.g. `7d`) |
| `CORS_ORIGINS` | Comma-separated browser origin allowlist — must match where the frontend is served |
| `THROTTLE_TTL_MS` / `THROTTLE_LIMIT` | Default rate-limit window (ms) and limit per route per client IP |
| `THROTTLE_STRICT_TTL_MS` / `THROTTLE_STRICT_LIMIT` | Stricter bucket for `/auth/login`, `/auth/refresh`, `/onboarding/signup` |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | Seeds the platform-admin credential on migrator run (min 12 chars); empty password skips it |
| `VITE_API_BASE_URL` | Frontend build-time value — the API origin the SPA calls |

`PORT` is not in `.env`; `docker-compose.yml` sets it to `3000` for the backend.

Rate limiting is **per process**: with more than one backend replica the effective limit is N times
the configured one.

## Conventions

- **Prisma is the ORM**, but the schema is owned by **hand-written SQL migrations** — Prisma cannot
  express RLS, grants or `SECURITY DEFINER` functions. Never regenerate a migration with
  `prisma migrate dev`.
- **pnpm only.** Never `npm install` or `yarn add`.
- Every tenant table enables **and forces** RLS in the migration that creates it, and gets explicit
  per-table grants for `app_user`.
- Tenant data is only touched inside `lib/tenant-db.ts` transactions; `runGlobal()` is the explicit,
  logged escape hatch for registry tables and SECURITY DEFINER lookups.
- Limit checks are one Postgres transaction with a row lock — never an in-memory counter, never an
  event handler.
- Tenant isolation is never enforced by a CASL rule or a hand-written `WHERE` clause alone.
- Events are published **after** commit and must never fail the request that published them.
