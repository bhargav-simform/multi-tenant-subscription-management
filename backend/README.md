# Backend

One Express 5 + Prisma 7 process — an MVC monolith against one PostgreSQL database (`app_db`).
See the [root README](../README.md) for the one-command `docker compose up`, and
[ARCHITECTURE.md](../docs/architecture/ARCHITECTURE.md) ("Current implementation" at the top) for
the design. This file covers only working inside `backend/`: layout, scripts, migrations, tests.

## Layout

```
src/
  server.ts            boot: assertRlsSafeRole() → registerEventHandlers() → startJobs() → listen
  app.ts               createApp(): helmet → CORS → express.json → correlation id → pino-http
                       → /api/v1 routes → errorHandler   (no listen — tests drive it with supertest)
  config/env.ts        every environment variable, read lazily through getters
  routes/              one Router per area; declares the per-route middleware chain
  controllers/         HTTP in/out only: read req, call a service, render a view, set the status
  services/            business logic, transactions, limit checks, publish() after commit
  models/              data access, one file per table (Prisma client + tagged raw SQL); every
                       function takes a `Tx`; maps Prisma rows to plain domain types (BigInt → number)
  views/               domain object → response body (the exact JSON the API has always returned)
  dtos/                class-validator request classes (bodies and queries)
  middlewares/         throttle, authenticate/anonymous, authorize/requirePlatformAdmin,
                       validateBody/validateQuery/parseUuidParam, correlation-id, error-handler
  events/              registerEventHandlers() + handlers/ (the former Kafka consumers)
  jobs/                node-cron: invitation-expiry sweep (hourly, :00), denylist purge (hourly, :30)
  lib/
    tenant-db.ts       transaction / transactionForOrganization / runGlobal /
                       transactionWithDeferredScope / assertRlsSafeRole
    context-store.ts   AsyncLocalStorage tenant context (opened only by middlewares/authenticate.ts)
    events/            in-process event bus: subscribe / publish / publishAll
    casl.ts            createAbilityForContext() — authorization only, never isolation
    http-errors.ts     HttpException + Nest-compatible subclasses, PlanLimitExceeded, LastAdmin
    prisma.ts          the one PrismaClient (app_user, via @prisma/adapter-pg)
    db-errors.ts, cursor.ts, hashing.ts, logger.ts
  types/               constants (roles, actions, subjects), event catalogue, tenant context
  generated/prisma/    Prisma client output — generated, git-ignored, never edit
prisma/
  schema.prisma        models mapped onto the hand-written schema
  migrations/          hand-written SQL, applied by `prisma migrate deploy`
  seed-platform-admin.ts
prisma.config.ts       Prisma CLI config — connects as app_migrator
tests/
  unit/                fast, no database (models/bus mocked)
  integration/         real Postgres via Testcontainers, services exercised as app_user
  http/                black-box HTTP contract tests (supertest against createApp())
  support/             PostgresTestContainer (production role layout + real migration)
```

Request flow: `route → throttle → authenticate | anonymous → [requirePlatformAdmin] →
authorize(action, subject) → validateBody | validateQuery → controller → service → model`.
Errors are thrown (Express 5 forwards rejected async handlers) and serialised by
`middlewares/error-handler.ts`; anything that is not an `HttpException` becomes a detail-free 500.

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| HTTP | Express + helmet + cors | 5.2 / 8.3 / 2.8 |
| Language | TypeScript (CommonJS, `node16` modules) | 5.9 |
| ORM | Prisma (`prisma-client` generator, `@prisma/adapter-pg` on `pg`) | 7.10 |
| Database | PostgreSQL, with Row-Level Security | 17 |
| Auth | `jsonwebtoken` + Argon2 | 9.0 / 0.45 |
| Authorization | CASL (`@casl/ability`) | 7.0 |
| Validation | class-validator + class-transformer | 0.15 / 0.5 |
| Logging | Pino + `pino-http` | 10.3 / 11.0 |
| Scheduling | node-cron | 4.6 |
| Testing | Jest + ts-jest + Supertest + Testcontainers | 30.5 / 29.4 / 7.3 / 12.1 |
| Lint / format | ESLint (typescript-eslint) + Prettier | 10.11 / 3.9 |
| Package manager | pnpm | 10.32.1 |
| Runtime | Node.js | `>= 22` |

## Scripts

```bash
cd backend
pnpm install
pnpm dev                    # tsx watch src/server.ts
pnpm build                  # prisma generate && tsc -p tsconfig.build.json  → dist/
pnpm start                  # node dist/src/server.js
pnpm prisma:generate        # regenerate src/generated/prisma after a schema.prisma change
pnpm migrate:deploy         # prisma migrate deploy (as app_migrator, via prisma.config.ts)
pnpm migrate:status         # prisma migrate status
pnpm seed:platform-admin    # idempotent; needs PLATFORM_ADMIN_PASSWORD (>= 12 chars)
pnpm typecheck              # tsc --noEmit
pnpm lint                   # eslint --fix over src/ and prisma/
pnpm format                 # prettier --write
```

`pnpm dev` needs a reachable database and the same `.env` Docker uses (it loads `backend/.env`,
then `../.env`). `docker-compose.yml` does **not** publish Postgres to the host, so to run the
backend outside Docker either publish it yourself (e.g. a local `docker-compose.override.yml`
with `ports: ['127.0.0.1:5432:5432']` on `postgres`) and set `POSTGRES_HOST=localhost`, or set
`DATABASE_URL` / `MIGRATOR_DATABASE_URL` directly. The backend refuses to start if the role it
connects as is a superuser or has `BYPASSRLS` — connect as `app_user`.

## Migrations

The schema is owned by **hand-written SQL** in `prisma/migrations/<NNNN_name>/migration.sql`.
Prisma cannot express RLS policies, `FORCE ROW LEVEL SECURITY`, per-table grants, partial unique
indexes or `SECURITY DEFINER` functions, so `schema.prisma` only has to *match* the tables closely
enough for the client to read and write them.

**Never run `prisma migrate dev`** (or `migrate reset` / `db push`) against this schema: it diffs
`schema.prisma` against the database, would try to drop what it cannot model, and would write a
migration with no RLS or grants.

To add a schema change:

1. Create the next folder, e.g. `prisma/migrations/0002_add_projects/migration.sql` (folders apply
   in lexical order; never edit a migration that has already been applied — its checksum is
   recorded in `_prisma_migrations`).
2. Write the DDL by hand. For a **tenant table**: `organization_id uuid NOT NULL`, `ENABLE` **and**
   `FORCE ROW LEVEL SECURITY`, the standard `tenant_isolation` policy with the `NULLIF(...)` form
   in both `USING` and `WITH CHECK` (copy it from `0001_init`), an index leading with
   `organization_id`, and explicit `GRANT ... TO app_user` for exactly the privileges it needs.
   Any new `SECURITY DEFINER` function is `OWNER TO app_rls_bypass`, `REVOKE ALL ... FROM PUBLIC`,
   `GRANT EXECUTE ... TO app_user`, with `SET search_path = public, pg_temp`.
3. Mirror the tables in `schema.prisma` (`@@map`/`@map` to the snake_case names, `@db.*` types),
   then `pnpm prisma:generate`.
4. Apply: `docker compose up migrator` (or `pnpm migrate:deploy` with migrator credentials), and
   check with `pnpm migrate:status`.
5. `tests/support/postgres-test-container.ts` currently applies only `0001_init` — extend it to
   apply every migration folder in order, or integration tests will run against the old schema.

Migrations run as `app_migrator` (DDL), never as `app_user`. The `.claude/skills/prisma-schema`
skill has the full checklist.

## Testing

```bash
cd backend
pnpm test                 # unit tests (tests/unit), no Docker needed
pnpm test:watch
pnpm test:cov
pnpm test:integration     # tests/integration + tests/http, real Postgres via Testcontainers (Docker required, slow)
pnpm jest tests/unit/users.service.spec.ts     # one file
```

Integration and HTTP tests start a `postgres:17-alpine` container per suite with the production
role layout (`app_migrator` / `app_user` / `app_rls_bypass`), apply the real migration, and point
the app's Prisma singleton at it **as `app_user`** — that is what proves RLS holds, not just that
the service calls the right model function.

## Conventions

- **pnpm only.** Controllers never touch Prisma; models never read the tenant context or `req`.
- Tenant data is read and written only inside a `lib/tenant-db.ts` transaction. `runGlobal()` is
  the logged escape hatch for registry tables, the plan catalogue, NULL-org audit rows and the
  SECURITY DEFINER lookups — on a tenant table it returns zero rows, by design.
- Limit checks (seats, storage) lock the counter row `FOR UPDATE` first, check, write and adjust in
  the same transaction; `CHECK` constraints are the backstop.
- `publish()` only after the transaction commits; a handler failure never fails the request.
- Throw `lib/http-errors.ts` exceptions for anything the client should see — response bodies are a
  frozen contract with the frontend.
