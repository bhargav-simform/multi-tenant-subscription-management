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

| Level | Tool | Scope |
|---|---|---|
| Unit | Jest + `@nestjs/testing` | Domain logic, ability factories, in-memory repos. No I/O |
| Integration | Jest + **Testcontainers** | Real Postgres: RLS, locks, constraints, migrations |
| Contract | Jest | Event envelope shapes producer ↔ consumer |
| E2E | Jest + supertest | Full flows through the gateway |
| Frontend | **Vitest + RTL** | Components, hooks, forms |

**Testcontainers is non-negotiable for integration.** RLS policies, `FOR UPDATE`
blocking and `CHECK` constraints are PostgreSQL behaviours. A mocked repository
proves nothing about them — it tests the mock. Verify this yourself once per
lock: temporarily remove the `.setLock(...)` (or the `FOR UPDATE` SQL) and
confirm your integration test fails while your unit test does not. A
concurrency unit test with an in-memory fake that serialises every call
unconditionally will pass even with the lock deleted — this happened once
already (`user-service`'s first pass) and was caught only by a review, not by
CI.

**Use `test/integration/support/postgres-test-container.ts`** — the shared
helper, not a new one per service. It creates the exact `app_migrator`/
`app_user` roles `docker/postgres/init.sh` creates in production
(`NOSUPERUSER`/`NOBYPASSRLS`, §13.5), runs your migration as `app_migrator`,
and connects as `app_user`. `pnpm test:integration` runs this suite (real
Docker, tens of seconds); `pnpm test` does not include it.

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
A repository method with NO tenant filter, plus a raw-SQL variant:
  dataSource.query('SELECT * FROM resources')
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
- **Role capability** — service DB role is non-superuser with `NOBYPASSRLS`.
- **Table classification** — every table is in `TENANT_TABLES` or `GLOBAL_TABLES`.

## Concurrency tests

Any limit needs three: sequential fill-to-cap, concurrent pair, and a 50-request burst
with 2 seats free (assert exactly 2 succeed). Real Postgres only.

## Unit tests

Bind an in-memory repository via the DI token — no database, no container:

```ts
const module = await Test.createTestingModule({
  providers: [
    UsersService,
    { provide: USER_REPOSITORY, useClass: InMemoryUserRepository },
  ],
}).compile();
```

## Frontend

Vitest + RTL. Test behaviour, not implementation — user-visible outcomes over internal
state. MSW mocks the API. Cover: login and token refresh, invite dialog surfacing the
409 message verbatim, role-based navigation, table pagination, form validation.

## Checklist

- [ ] New tenant table → isolation test added
- [ ] New limit → all three concurrency tests
- [ ] New role/ability → tests for allowed **and** denied
- [ ] New event → contract test
- [ ] Integration tests use Testcontainers, not mocks
- [ ] T1–T4 still present and not skipped
