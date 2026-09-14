---
name: tenant-isolation
description: >
  Enforce and audit structural tenant isolation. Use when: adding a new entity or
  table, writing any query or repository method, creating a migration, adding a
  Kafka consumer, reviewing a diff for cross-tenant leaks, or when the user says
  "add tenant scoping", "is this tenant safe", "audit isolation", "new table",
  "RLS", "cross-tenant", "organization_id". ALWAYS invoke before merging a change
  that touches the database layer.
---

# Tenant Isolation — Implement & Audit

Tenant isolation in this system is **structural**: enforced by PostgreSQL Row-Level
Security, not by developers remembering to add a filter. Your job is to keep that
property true. Reference: `docs/architecture/ARCHITECTURE.md` §13.

## The four layers

| Layer | Mechanism | Location |
|---|---|---|
| 1 Origin | `orgId` from a signed JWT claim only | api-gateway |
| 2 Transport | `AsyncLocalStorage` tenant context | `libs/tenant-context` |
| 3 **Database** | **PostgreSQL RLS — the real guarantee** | migrations |
| 4 Detection | 404 + `CrossTenantAccessAttempted` event | each service |

Layer 3 is the one that matters. Layers 1, 2 and 4 are how it gets its input and
how violations get noticed.

## Non-negotiable rules

1. **Every tenant-owned table has `organization_id`** and extends `TenantBaseEntity`.
2. **Every tenant-owned table enables AND forces RLS in the same migration that
   creates it.** Never in a follow-up migration — a gap between them is a live leak.
3. **`orgId` is never read from a request body, query param, path segment or client
   header.** Only from `TenantContext.get()`.
4. **No DTO may contain an `organizationId` field.** `forbidNonWhitelisted` rejects it,
   but it must never be declared in the first place.
5. **No route is shaped `/organizations/:orgId/...`.** The org is implied by the token.
6. **Cross-tenant access returns 404, never 403.** A 403 confirms existence.
7. **No bypass mechanism.** No `skipRls`, no `asSystem()`, no admin pool, no boolean
   parameter that disables scoping. If one seems necessary, stop and escalate —
   it is an architecture change, not an implementation detail.

## Adding a new tenant-owned table

Work through all six steps. Skipping step 2 is the single most dangerous mistake
possible in this codebase.

### 1. Entity extends `TenantBaseEntity`

```ts
@Entity('widgets')
export class Widget extends TenantBaseEntity {
  @Column() name: string;
}
```

### 2. Migration enables AND forces RLS — same migration

```sql
CREATE TABLE widgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  ...
);

ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE widgets FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON widgets
  USING      (organization_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid);

CREATE INDEX idx_widgets_org_created ON widgets (organization_id, created_at DESC, id);
```

`WITH CHECK` is not optional — without it a write can plant a row in another tenant.
`FORCE` is not optional — without it the table owner bypasses the policy.

### 3. Register in `TENANT_TABLES`

Add to the tenant-table list consumed by the §13.8 CI check. A table in none of
`GLOBAL_TABLES`, `REGISTRY_TABLES`, or `TENANT_TABLES` fails the build, by design.

`REGISTRY_TABLES` (`organizations`, `onboarding_sagas`) is a third, narrow category:
the tenant registry itself, not tenant content — deliberately NOT RLS-protected
because a platform admin legitimately reads them directly (§13.6). Only add a table
here if it IS the registry/orchestration layer itself. Never add a table here
because scoping it felt inconvenient — that is exactly the mistake this registry
exists to catch.

### 4. Repository extends `TenantRepository`

Defence in depth and better errors. RLS remains the guarantee.

### 5. Access via `TenantAwareDataSource`

Never open a raw `DataSource` connection. The wrapper issues `SET LOCAL app.current_org`.

### 6. Add the isolation test

Seed two orgs, query as one, assert the other's rows are absent.

## Audit checklist

Run through this on any diff touching data access:

- [ ] New tables: RLS enabled **and** forced, policy has `USING` **and** `WITH CHECK`
- [ ] Registered in `TENANT_TABLES`
- [ ] Entity extends `TenantBaseEntity`
- [ ] No `organizationId` in any DTO
- [ ] No `orgId` read from `req`, body, params or query
- [ ] No route exposes an org ID in its path
- [ ] Cross-tenant paths return 404, not 403
- [ ] Kafka consumers open ALS from the event envelope before handling
- [ ] No new raw `DataSource` / `createConnection` outside the wrapper
- [ ] No `skipRls`-shaped escape hatch introduced
- [ ] Index leads with `organization_id`

## Kafka consumers

Consumers run outside any HTTP request, so they have no ambient context. The base
consumer class opens an ALS scope from `envelope.organizationId` before invoking the
handler. A handler must never receive a raw payload with no scope established — if
you find yourself writing `als.run` inside a handler, the base class is being bypassed.

## Verifying a suspected leak

1. `grep` for raw SQL outside `TenantAwareDataSource`.
2. Check the service's DB role: must be non-superuser, `NOBYPASSRLS`, not table owner.
3. Confirm `SET LOCAL` (never `SET`) — `SET` leaks across pooled connections.
4. Query `pg_class.relrowsecurity` and `relforcerowsecurity` for the table.
5. Check `security_events` grouped by actor for probing patterns.

## The test that proves it

`test/integration/careless-query.spec.ts` runs an unfiltered query, including a raw-SQL
variant, and asserts only the current tenant's rows return. **If this test is ever
deleted or skipped, the architecture's central claim is unverified.** Treat a change
that touches it as an architecture change.
