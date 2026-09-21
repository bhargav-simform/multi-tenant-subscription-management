# Backend

NestJS monorepo, seven services, one pnpm workspace. See the
[root README](../README.md) for the one-command `docker compose up` way to run the whole stack,
and [ARCHITECTURE.md](../docs/architecture/ARCHITECTURE.md) for the full design. This file covers
only what's specific to working inside `backend/` — running a single service, migrations, tests.

## Services

| Service | Owns |
|---|---|
| `api-gateway` | The one published, internet-facing entry point. JWT verification, CORS, rate limiting, request signing for every downstream call. No business logic. |
| `auth-service` | Credentials, login, JWT issue/refresh. The only service that ever sees a password. |
| `tenant-service` | Organisations, self-service onboarding saga. |
| `user-service` | Users and invitations within an organisation. |
| `subscription-service` | Plans, subscriptions, seat/storage limit enforcement (the H2 concurrency case). |
| `resource-service` | Tenant-owned resources (the H1 cross-tenant isolation case). |
| `audit-service` | Security and audit event log, consumed from Kafka. |

Each service owns its own data — no service reaches into another's tables. §7 of the architecture
doc explains why each one exists; §14 says who owns what.

## Stack

NestJS · TypeScript · **TypeORM** (the only permitted ORM — never Prisma, Sequelize, Drizzle or
Mongoose) · PostgreSQL with Row-Level Security · Kafka (KRaft mode) · Redis · JWT + Passport +
Argon2 · CASL · **pnpm** (never `npm install` or `yarn add`) · Jest + Testcontainers.

## Install

```bash
cd backend
pnpm install
```

## Running a single service outside Docker

Normal development runs the whole stack via `docker compose up` (see the root README) — Postgres,
Redis and Kafka all need to be reachable, and every service reads the same `.env`. To run one
service directly against those (e.g. for a debugger or fast iteration), start its infrastructure
dependencies via Docker first, then:

```bash
cd backend
pnpm nest start <service-name> --watch    # e.g. pnpm nest start user-service --watch
```

`<service-name>` is any key from `nest-cli.json`'s `projects` map — the same seven names listed
above.

## Building

```bash
cd backend
pnpm build                    # builds api-gateway (nest-cli.json's default project)
pnpm nest build <service-name>   # build one specific service
pnpm nest build                  # build every project in the monorepo
```

Docker builds each service's image itself (`backend/Dockerfile`, parameterised by `SERVICE` —
see `docker-compose.yml`'s `build.args` per service); you don't need to run this manually for
`docker compose up` to work.

## Migrations

Each database-owning service has its own TypeORM `DataSource` at
`apps/<service>/src/database/data-source.ts` and its own migration scripts, run from inside that
service's directory:

```bash
cd backend/apps/user-service
pnpm migration:run       # apply pending migrations
pnpm migration:revert    # revert the last one
pnpm migration:show      # list applied / pending
```

These connect as `app_migrator` (DDL rights), never as the runtime `app_user` role. In normal use
you don't run these by hand at all — the one-shot `migrator` container
(`docker/migrator/run-migrations.sh`) runs every service's migrations in the correct order and
exits before any application service starts.

**Ordering matters for one pair**: `user-service`'s `core_db` migrations must run *before*
`subscription-service`'s — the latter `ALTER TABLE`s a table the former creates (§32.3 of the
architecture doc). The migrator script encodes that ordering; don't run these two services'
migrations out of order by hand.

## Testing

```bash
cd backend
pnpm test               # unit tests, every service and lib
pnpm test:watch          # unit tests, watch mode
pnpm test:cov            # unit tests with coverage
pnpm test:integration    # integration tests against real Postgres via Testcontainers (slow)
pnpm typecheck           # tsc --noEmit across the whole workspace
pnpm lint                # eslint --fix across apps/ and libs/
```

Run a single test file or suite with Jest's usual filters, e.g.:

```bash
NODE_OPTIONS=--experimental-vm-modules pnpm jest apps/user-service/src/users/__tests__/users.service.spec.ts
NODE_OPTIONS=--experimental-vm-modules pnpm jest libs/authorization
```

Integration tests (`test:integration`) spin up a real PostgreSQL container per suite via
Testcontainers and run against it using the same non-superuser `app_user` role production uses —
this is what actually proves Row-Level Security holds, not just that the application code calls
the right repository method. They live under `test/integration/<service>/`.

## Conventions specific to the backend

- **TypeORM only.**
- **pnpm only.**
- Every tenant table enables **and forces** RLS in the migration that creates it — never rely on
  a CASL rule or a hand-written `WHERE organization_id = ...` clause for isolation.
- Limit checks (seats, storage) are one Postgres transaction with `SELECT ... FOR UPDATE` on the
  relevant row — never Redis, never Kafka.
- A `SECURITY DEFINER` function that needs to bypass RLS is owned by `app_rls_bypass` (a `NOLOGIN`
  role created in `docker/postgres/init.sh`), never by `app_migrator` — see the comment in
  `apps/user-service/src/database/migrations/1700000000004-AddUserExistsFunction.ts` for the
  reasoning and the empirically-confirmed failure mode it fixes.

Full implementation rules live in [.claude/skills/](../.claude/skills/) — in particular
`tenant-isolation`, `concurrency-safety`, `casl-authorization`, `nest-service` and
`typeorm-entity`.
