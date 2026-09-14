---
name: typeorm-entity
description: >
  Create or modify TypeORM entities and migrations. Use when: adding a table or
  column, writing a migration, adding an index or constraint, changing schema, or
  when the user says "add entity", "new table", "migration", "add column",
  "schema change". TypeORM is the ONLY permitted ORM.
---

# TypeORM Entities & Migrations

Reference: `docs/architecture/ARCHITECTURE.md` §14, §15.

**TypeORM only.** Never install or use Prisma, Sequelize, Drizzle or Mongoose.

## Configuration invariants

| Setting | Value | Why |
|---|---|---|
| `synchronize` | `false` — every environment | Would silently drop RLS policies |
| `migrationsRun` | `false` | Migrations are a deploy step, not a boot side effect |
| `namingStrategy` | `SnakeNamingStrategy` | `organizationId` ↔ `organization_id` |
| `entities` | Explicit imports, never globs | A glob can load another service's entity |
| `logging` | `['error','warn','migration']`; `query` in dev only | Query logs contain tenant data |

## Entity rules

- Entities live in the **service that owns them**. No shared entity library.
- `libs/common` holds types, DTOs and event contracts — **never `@Entity()`**.
- Every tenant-owned entity **extends `TenantBaseEntity`** (`id`, `organizationId`,
  `createdAt`, `updatedAt`, `deletedAt`).
- Global tables (`plans`, migrations) do not extend it and are listed in `GLOBAL_TABLES`.

```ts
@Entity('resources')
export class Resource extends TenantBaseEntity {
  @Column() name: string;
  @Column({ type: 'bigint', default: 0 }) sizeBytes: number;
  @Column({ name: 'created_by', type: 'uuid' }) createdBy: string;
}
```

## Migration rules

1. **Every migration creating a tenant table enables and forces RLS in the same
   migration.** See the `tenant-isolation` skill for the exact SQL. A follow-up
   migration is not acceptable — the gap is a live leak.
2. Indexes on tenant tables **lead with `organization_id`** — one index serves both
   the RLS predicate and the query.
3. Counter columns that back a limit need a `CHECK` constraint, with the limit
   denormalised onto the same row (a `CHECK` cannot span tables).
4. Migrations run as `app_migrator`. The runtime role `app_user` has no DDL rights.
5. Never edit a migration that has run. Write a new one.
6. Write `down()` properly — an irreversible migration is a deployment trap.

## Keyset pagination

Lists use keyset, never OFFSET (§29):

```sql
WHERE (created_at, id) < ($cursor_ts, $cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT $n
```

Requires the index `(organization_id, created_at DESC, id)`.

## Transactions

Explicit `dataSource.transaction(async (manager) => …)` in the application service.
Never a decorator hiding the boundary. **No network calls inside** — no HTTP, no
Kafka, no Redis (§15.5).

## Repository pattern

Services depend on interfaces, not `Repository<T>`:

```
IUserRepository (domain)  ◄── implements ── TypeOrmUserRepository (infrastructure)
```

Implementations extend `TenantRepository`, which auto-injects `organization_id`.
Access the database only via `TenantAwareDataSource` — it issues `SET LOCAL`
(never `SET`, which leaks across pooled connections).

## Checklist

- [ ] Tenant entity extends `TenantBaseEntity`
- [ ] Migration enables **and** forces RLS with `USING` + `WITH CHECK`
- [ ] Registered in `TENANT_TABLES` or `GLOBAL_TABLES`
- [ ] Index leads with `organization_id`
- [ ] `CHECK` constraint on any limit-backing counter
- [ ] `down()` implemented
- [ ] No entity added to `libs/`
- [ ] `synchronize` still `false`
