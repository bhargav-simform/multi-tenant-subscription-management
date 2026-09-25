---
name: tenant-isolation
description: >
  Enforce and audit structural tenant isolation. Use when: adding a new table,
  writing any query or model function, creating a migration, adding an event handler
  or job, reviewing a diff for cross-tenant leaks, or when the user says "add tenant
  scoping", "is this tenant safe", "audit isolation", "new table", "RLS",
  "cross-tenant", "organization_id". ALWAYS invoke before merging a change that
  touches the database layer.
---

# Tenant Isolation — Implement & Audit

Tenant isolation in this system is **structural**: enforced by PostgreSQL Row-Level
Security, not by developers remembering to add a filter. Your job is to keep that
property true. Reference: `docs/architecture/ARCHITECTURE.md` §0.2, §13.

## The four layers

| Layer | Mechanism | Location (`backend/src/`) |
|---|---|---|
| 1 Origin | `organizationId` from the verified JWT claim only | `middlewares/authenticate.ts` |
| 2 Transport | `AsyncLocalStorage` tenant context | `lib/context-store.ts` |
| 3 **Database** | **PostgreSQL RLS — the real guarantee**, applied per transaction by `set_config('app.current_org', org, true)` | `lib/tenant-db.ts` + `prisma/migrations/*` |
| 4 Detection | 404 + `CrossTenantAccessAttempted` on `security.events` | services (`resources.service.ts`, `users-read.service.ts`) |

Layer 3 is the one that matters. Layers 1, 2 and 4 are how it gets its input and how
violations get noticed.

## Non-negotiable rules

1. **Every tenant-owned table has `organization_id uuid NOT NULL`.**
2. **Every tenant-owned table enables AND forces RLS in the same migration that
   creates it**, with the `NULLIF` policy in `USING` and `WITH CHECK`, and explicit
   `GRANT`s to `app_user`. Never in a follow-up migration.
3. **Tenant data is only touched inside a `lib/tenant-db.ts` transaction.** Never
   `getPrisma().<model>` directly for tenant tables — without `set_config` RLS returns
   nothing (fails closed) and the code is wrong.
4. **`organizationId` is never read from a request body, query param, path segment or
   client header.** Only from `contextStore.getOrThrow()`. Only `authenticate.ts`
   reads identity from `req`.
5. **No DTO declares an `organizationId` (or `createdBy`) field.** `forbidNonWhitelisted`
   rejects a smuggled one.
6. **No route is shaped `/organizations/:orgId/...`.** The org is implied by the token.
7. **Cross-tenant access returns 404, never 403.** A 403 confirms existence.
8. **No new bypass mechanism.** No `skipRls` flag, no admin pool, no role with
   `BYPASSRLS` that the app logs in as. The only sanctioned exceptions are `runGlobal()`
   (unscoped — sees zero tenant rows) and narrow `SECURITY DEFINER` functions owned by
   `app_rls_bypass` returning one id or one boolean. Anything else is an architecture
   change: stop and escalate.
9. **The app connects as `app_user`** (`NOSUPERUSER NOBYPASSRLS`, not table owner).
   `assertRlsSafeRole()` in `server.ts` must keep running at boot.

## Choosing the transaction helper

| Situation | Helper |
|---|---|
| Request path, caller's own org | `transaction(work)` |
| Event handler / cron job for a known org | `transactionForOrganization(orgId, work)` |
| Org discovered mid-transaction (invitation accept) | `transactionWithDeferredScope((tx, scope) => …)` |
| Registry tables (`credentials`, `refresh_tokens`, `revoked_access_tokens`, `organizations`, `onboarding_sagas`), `plans`, NULL-org audit rows, SECURITY DEFINER calls | `runGlobal(work)` — logged at `warn`; on a tenant table it returns zero rows |

A platform admin (`organizationId === null`) through `transaction()` runs unscoped and
therefore sees zero tenant rows — by policy, not by an `if`.

## Adding a new tenant-owned table

1. **Migration** (see the `prisma-schema` skill for the full template):

   ```sql
   ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "widgets" FORCE  ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON "widgets"
     USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
     WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
   CREATE INDEX "idx_widgets_org_created" ON "widgets" ("organization_id", "created_at" DESC, "id");
   GRANT SELECT, INSERT, UPDATE, DELETE ON "widgets" TO app_user;
   ```

   `WITH CHECK` stops a write planting a row in another tenant. `FORCE` stops the owner
   bypassing the policy. `NULLIF` stops `''::uuid` raising on a pooled connection.
2. **Classify it.** Add it to the tenant-table list in the RLS-coverage integration test
   (search `backend/tests/integration` for `TENANT_TABLES`) so the check asserting
   `relrowsecurity` + `relforcerowsecurity` + a policy covers it. A registry table
   (tenant reference, but only ever looked up by a unique key the caller already holds,
   never listed per org) needs its justification written at the `CREATE TABLE`.
3. **Model** in `models/<table>.model.ts`, functions taking `Tx`; include
   `organizationId` in `WHERE` clauses as defence in depth — RLS remains the guarantee.
4. **Service** uses a `lib/tenant-db.ts` helper.
5. **Isolation test**: seed two orgs, query as one, assert the other's rows are absent —
   including a raw-SQL `SELECT *` variant and a no-scope variant that must return 0 rows.

## Audit checklist

- [ ] New tables: RLS enabled **and** forced, `NULLIF` policy with `USING` **and** `WITH CHECK`
- [ ] Explicit, minimal grants to `app_user`; nothing via default privileges
- [ ] Added to the RLS-coverage test's tenant list (or justified as registry/global)
- [ ] All tenant queries inside `transaction` / `transactionForOrganization` / deferred scope
- [ ] `runGlobal()` only for registry/global/NULL-org work — each new use justified
- [ ] No `organizationId` in any DTO; none read from `req`, body, params or query
- [ ] No route exposes an org id in its path
- [ ] Cross-tenant paths return 404, not 403 (probe via SECURITY DEFINER only for the event)
- [ ] Event handlers scope from `envelope.organizationId`, never from ambient context
- [ ] New SECURITY DEFINER function: owned by `app_rls_bypass`, returns an id/boolean only
- [ ] Index leads with `organization_id`

## Event handlers and jobs

They run outside a request. `lib/events` opens a fresh scope from the envelope before
each handler; handlers then scope their transaction explicitly with
`transactionForOrganization(envelope.organizationId, …)`. Jobs have no context at all
and must do the same per org. Never widen a handler to `runGlobal` to "make it work" —
zero rows from an unscoped read of a tenant table is RLS working.

## Verifying a suspected leak

1. `grep -rn "getPrisma()" backend/src` — any hit outside `lib/`, `models/` called with
   `getPrisma()` for a tenant table, or services using it for tenant data, is suspect.
2. Confirm the app role: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`.
3. Confirm `set_config(..., true)` (transaction-local), never `SET` / session-level.
4. `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = '<table>'`.
5. Check `security_events` grouped by actor for probing patterns.

## The test that proves it

The careless-query test (T2) in `backend/tests/integration` runs an unfiltered query,
including a raw-SQL variant, as `app_user` against real Postgres and asserts only the
current tenant's rows return — and zero rows with no scope. **If it is ever deleted or
skipped, the architecture's central claim is unverified.** Treat a change that touches
it as an architecture change.
