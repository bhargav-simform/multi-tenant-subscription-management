---
name: testing
description: >
  Write or review tests. Use when: adding a test, deciding what to test, reviewing
  coverage of a change, setting up Testcontainers, or when the user says "add tests",
  "test this", "write a test", "coverage". The four critical tests (T1-T4) must never
  be deleted or skipped.
---

# Testing Strategy

Reference: `docs/architecture/ARCHITECTURE.md` §28.

## Levels

| Level | Where | Tool | Scope | Run |
|---|---|---|---|---|
| Unit | `backend/tests/unit/` | Jest + ts-jest | Services, handlers, CASL, middleware — models, `lib/events`, `lib/prisma` mocked with `jest.mock`. No I/O | `pnpm test` |
| Integration | `backend/tests/integration/` | Jest + **Testcontainers** | Real Postgres as `app_user`: RLS, locks, constraints, grants, SECURITY DEFINER functions, the migration itself | `pnpm test:integration` |
| HTTP contract | `backend/tests/http/` | Jest + Supertest + Testcontainers | Black-box through `createApp()`: paths, statuses, bodies, headers — the frozen API contract | `pnpm test:integration` |
| Frontend | `frontend/` | **Vitest + RTL** | Components, hooks, forms | see frontend README |

**Testcontainers is non-negotiable for integration.** RLS policies, `FOR UPDATE`
blocking and `CHECK` constraints are PostgreSQL behaviours. A mocked model
proves nothing about them — it tests the mock. Verify this yourself once per
lock: temporarily remove the `FOR UPDATE` from the model's SQL and confirm your
integration test fails while your unit test does not. A concurrency unit test
with a mocked model will pass even with the lock deleted — this happened once
already (the first seat-lock tests) and was caught only by a review, not by CI.

**Use `backend/tests/support/postgres-test-container.ts`** (`PostgresTestContainer`)
— the shared helper, not a new one per suite. It creates the exact
`app_migrator` / `app_user` / `app_rls_bypass` roles `docker/postgres/init.sh`
creates (`NOSUPERUSER`/`NOBYPASSRLS`, §13.5), applies the real migration SQL as
`app_migrator`, and points the app's Prisma singleton at the database **as
`app_user`** via `setPrisma()`. `asMigrator()` / `asSuperuser()` exist for
seeding fixtures past RLS; `asAppUser()` for a "careless" raw query. It
currently applies only `0001_init` — extend it when a migration is added.
Integration suites need Docker and take tens of seconds; `pnpm test` does not
include them.

## The four critical tests

These are deliverables, not coverage incidentals. **Never delete or skip them.**

**T1 — Cross-tenant read by ID is impossible**
```
Seed two orgs with one resource each; authenticate as Org A; GET Org B's resource by ID.
Assert: 404 (not 403), no trace of the resource in the body,
        a CrossTenantAccessAttempted event written.
Repeat for /users/:id, PATCH role, DELETE resource.
```

**T2 — The careless query does not leak**
```
A model function with NO tenant filter, plus a raw-SQL variant:
  tx.$queryRaw`SELECT * FROM resources`   (resources.service findAllResourcesForReport)
Seed 3 for Org A, 2 for Org B; run in Org A's context.
Assert: exactly 3 rows. Then run with no tenant context: assert 0 rows (fails closed).
```
This is the architecture's central claim made executable. If it fails, tenant
isolation has regressed to a matter of discipline.

**T3 — Concurrent invites cannot both succeed**
```
Org on a 5-seat plan with 4 seats held; fire 2 invites via Promise.all.
Assert: exactly one 201, exactly one 409, used_seats = 5.
```
A seat is held by a user OR a pending invitation (D-Q1), so this test has seven
variants (V1-V7). **See ARCHITECTURE.md §28.2 for the canonical list** — do not
maintain a second copy here. Every variant asserts the same invariant:

    used_seats == active users + pending unexpired invitations

**T4 — Platform admin cannot see content**
```
As a platform admin: org list returns metadata; subscription returns integers;
resource/user endpoints return 403 or empty, never content; known resource by ID → 404.
Then sweep every registered route asserting none returns a tenant content field.
```
The route sweep matters — the brief says an admin route that *happens* to expose
content is a failure even if the UI never links to it.

## Structural guard tests (CI)

- **RLS coverage** — every table with `organization_id` has RLS enabled, forced, and
  a policy. Fails the build on a new unprotected table.
- **Role capability** — `assertRlsSafeRole()` passes as `app_user` and refuses a
  superuser / `BYPASSRLS` role.
- **Grants** — audit tables reject `UPDATE`/`DELETE` from `app_user`; `plans` is read-only.
- **Table classification** — every table is explicitly tenant (in the `TENANT_TABLES`
  list of the RLS-coverage test) or registry/global.

## Concurrency tests

Any limit needs three: sequential fill-to-cap, concurrent pair, and a 50-request burst
with 2 seats free (assert exactly 2 succeed). Real Postgres only.

## Unit tests

No DI container: mock the modules a service imports, and run inside a context scope.

```ts
jest.mock('../../src/lib/prisma', () => ({ getPrisma: () => ({}) }));
jest.mock('../../src/lib/events', () => ({ publish: jest.fn(), publishAll: jest.fn() }));
jest.mock('../../src/models/user.model', () => ({ findById: jest.fn(), create: jest.fn() }));
// stub lib/tenant-db's transaction to call work({}) if the test needs it

await contextStore.run(ctx, () => usersService.invite({ email, role: 'org_member' }));
expect(events.publish).toHaveBeenCalledWith(TOPICS.USER, expect.objectContaining({ ... }));
```

Unit tests prove shape and ordering (lock → check → write → publish after commit);
they cannot prove the lock or RLS works.

## HTTP contract tests

The public API is a frozen contract with the frontend (the rewrite was verified by a
black-box HTTP diff). For any route change, assert status, the exact error body
(`message` / `error` / `statusCode` / `details`) and relevant headers (rate-limit,
`x-correlation-id`) through `createApp()` + Supertest against a Testcontainers database.
Call `resetThrottleState()` between tests that hammer one route.

## Frontend

Vitest + RTL. Test behaviour, not implementation — user-visible outcomes over internal
state. MSW mocks the API. Cover: login and token refresh, invite dialog surfacing the
409 message verbatim, role-based navigation, table pagination, form validation.

## Checklist

- [ ] New tenant table → isolation test added
- [ ] New limit → all three concurrency tests
- [ ] New role/ability → tests for allowed **and** denied
- [ ] New event handler → unit test; audit row asserted where it matters
- [ ] Route change → HTTP contract test (status + body)
- [ ] Integration tests use Testcontainers, not mocks
- [ ] T1–T4 still present and not skipped
