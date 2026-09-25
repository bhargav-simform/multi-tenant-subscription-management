---
name: prisma-schema
description: >
  Create or modify database tables, columns, indexes, constraints and migrations for
  the Prisma backend. Use when: adding a table or column, writing a migration, adding
  an index or constraint, changing schema.prisma, writing a model file, or when the
  user says "add table", "new table", "migration", "add column", "schema change",
  "prisma". Migrations are HAND-WRITTEN SQL — never `prisma migrate dev`.
---

# Prisma Schema & Migrations

Reference: `docs/architecture/ARCHITECTURE.md` §0, §14.5, §15. Worked example:
`backend/prisma/migrations/0001_init/migration.sql`.

**The SQL migrations own the schema. `schema.prisma` only mirrors it.** Prisma cannot
express RLS policies, `FORCE ROW LEVEL SECURITY`, per-table grants, partial unique
indexes or `SECURITY DEFINER` functions.

**Never run `prisma migrate dev`, `prisma migrate reset` or `prisma db push`.** They
diff `schema.prisma` against the database and would drop or omit everything Prisma
cannot model. No other ORM (TypeORM, Sequelize, Drizzle, Mongoose) is added either.

## Adding a migration

1. New folder, next number: `backend/prisma/migrations/0002_<snake_name>/migration.sql`.
   Folders apply in lexical order. **Never edit an applied migration** — its checksum
   is in `_prisma_migrations`; write a new one.
2. Write the DDL by hand (templates below). It runs as `app_migrator`, never `app_user`.
3. Mirror it in `backend/prisma/schema.prisma`, then `pnpm prisma:generate`.
4. Apply: `docker compose up migrator` (or `pnpm migrate:deploy` with migrator
   credentials); verify with `pnpm migrate:status`.
5. `backend/tests/support/postgres-test-container.ts` applies only `0001_init` today —
   make it apply every migration folder in order, or integration tests miss the change.

## Tenant table template

```sql
CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
CREATE INDEX "idx_projects_org_created" ON "projects" ("organization_id", "created_at" DESC, "id");

ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "projects"
  USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "projects" TO app_user;   -- only what the app needs
```

Rules:

- RLS is enabled **and forced** in the **same** migration that creates the table. A
  follow-up migration is a live leak window.
- The `NULLIF(..., '')` form in **both** `USING` and `WITH CHECK` — a bare
  `::uuid` cast raises on a pooled connection where the setting reverted to `''`.
- **Explicit per-table grants.** There is no `ALTER DEFAULT PRIVILEGES`; a table with no
  `GRANT` is unusable by the app. Grant the minimum: audit-style tables get
  `SELECT, INSERT` only (append-only), reference data `SELECT` only.
- Indexes on tenant tables **lead with `organization_id`**.
- A counter backing a limit gets `CHECK (used <= max_snapshot)` and `CHECK (used >= 0)`,
  with the limit denormalised onto the same row (a `CHECK` cannot span tables).
- Name constraints and indexes explicitly (`uq_`, `idx_`, `ck_`, `fk_`) and reference
  those names in `schema.prisma` via `map:`.

**Registry / global tables** (no tenant content, looked up by unique key only — like
`credentials`, `organizations`, `plans`) get no RLS, but the classification must be
deliberate and stated in a comment at the `CREATE TABLE`.

## SECURITY DEFINER lookup template

Only for a narrow cross-tenant question (one id or one boolean, never content):

```sql
CREATE FUNCTION "project_exists"(p_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM projects WHERE id = p_id); $$;

GRANT SELECT ON "projects" TO app_rls_bypass;
ALTER FUNCTION "project_exists"(uuid) OWNER TO app_rls_bypass;   -- NOT app_migrator
REVOKE ALL ON FUNCTION "project_exists"(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "project_exists"(uuid) TO app_user;
```

The owner must be `app_rls_bypass` (`NOLOGIN BYPASSRLS`): FORCE RLS applies to a
definer function's owner, so an `app_migrator`-owned function bypasses nothing.

## `schema.prisma` mapping

```prisma
model Project {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organizationId String    @map("organization_id") @db.Uuid
  name           String    @db.VarChar(255)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt      DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz
  deletedAt      DateTime? @map("deleted_at") @db.Timestamptz

  @@index([organizationId, createdAt(sort: Desc), id], map: "idx_projects_org_created")
  @@map("projects")
}
```

- camelCase fields with `@map` to snake_case; `@@map` to the table name; enums `@@map`
  to the Postgres enum type name.
- Exact `@db.*` types (`Uuid`, `Citext`, `Timestamptz`, `VarChar(n)`), `BigInt` for
  `bigint`.
- Anything Prisma cannot represent (partial index, CHECK, policy) gets a `//` comment
  pointing at the SQL.

## Model files (`backend/src/models/<table>.model.ts`)

- The only code that queries the table. Every function takes `db: Tx` (from
  `lib/tenant-db.ts`) as its first argument and never opens its own transaction.
- Never read `contextStore` or `req`; the org id, when needed in a `WHERE`, is passed
  in (defence in depth — RLS is the guarantee).
- Export plain domain types and convert at the boundary: **`BigInt` → `Number(...)`**
  (Prisma returns `bigint` for `bigint` columns and raw queries; JSON cannot serialise
  it, and the API has always returned numbers).
- Use the typed client for simple CRUD; tagged `db.$queryRaw` / `$executeRaw` for
  `FOR UPDATE`, keyset row comparisons and SECURITY DEFINER calls. Always parameterise
  (`${value}::uuid`), never interpolate with `Prisma.raw`.
- Map unique violations with `lib/db-errors.ts` `isUniqueViolation()` into a domain
  error the service turns into a 409.

## Keyset pagination

Never OFFSET (§29):

```ts
const rows = await db.$queryRaw<Row[]>`
  SELECT ... FROM projects
  WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL ${cursorFilter}
  ORDER BY created_at DESC, id DESC
  LIMIT ${limit + 1}`;
// cursorFilter = Prisma.sql`AND (created_at, id) < (${ts}::timestamptz, ${id}::uuid)`
```

Use `lib/cursor.ts` to encode/decode; return `{ items, hasMore, nextCursor }`.

## Checklist

- [ ] New migration folder; no applied migration edited
- [ ] Tenant table: `ENABLE` + `FORCE` RLS, `NULLIF` policy with `USING` + `WITH CHECK`
- [ ] Explicit minimal `GRANT ... TO app_user`
- [ ] Index leads with `organization_id`; constraints named
- [ ] `CHECK` on any limit-backing counter
- [ ] SECURITY DEFINER functions owned by `app_rls_bypass`, `REVOKE ... FROM PUBLIC`
- [ ] `schema.prisma` mirrors it; `pnpm prisma:generate` run
- [ ] Model converts `BigInt` to `number`, takes `Tx`
- [ ] Test container applies the new migration; `tenant-isolation` skill run
