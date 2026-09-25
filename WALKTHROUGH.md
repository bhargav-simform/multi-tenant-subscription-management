# Walkthrough: What Was Built, Feature by Feature

This maps every piece of the system — the backend and the frontend — back to
`docs/architecture/POC-BRIEF.md`'s requirements, section by section, with actual
file paths so you can jump straight to the code.

**Reading order:** Part A covers the backend — its shape, the data model, and the
two hard-case mechanisms (H1 tenant isolation, H2 concurrency) that everything else
in the brief is subordinate to. Part B covers the frontend, built on top of that
backend. Part C records two real backend bugs found while wiring the frontend to the
*original* microservice backend — kept as history.

> **Backend rewrite note.** The backend was originally seven NestJS + TypeORM
> services over five databases, with Kafka and Redis. It is now **one Express 5 +
> Prisma 7 process** (`backend/src`) against **one database** (`app_db`), with
> identical external API behaviour (verified by a 99-step black-box HTTP diff against
> the old stack). The RLS, locking and security mechanisms below are unchanged in
> substance; only where they live has moved. Old → new names: `users.users` →
> `users`, `users.invitations` → `invitations`, `subs.subscriptions` →
> `subscriptions`, `subs.plans` → `plans`; each old service is now a set of
> `routes/ controllers/ services/ models/ views/` files.

---

# Part A — Backend

## The shape: one process, MVC, one database

| Layer | Where | Responsibility |
|---|---|---|
| Routes | `backend/src/routes/*.routes.ts` | Path + the per-route middleware chain: `throttle → authenticate \| anonymous → [requirePlatformAdmin] → authorize(action, subject) → validate → controller` |
| Controllers | `backend/src/controllers/` | HTTP in/out only |
| Services | `backend/src/services/` | Business logic, transactions, limit checks, `publish()` after commit |
| Models | `backend/src/models/` | Prisma queries and tagged raw SQL, one file per table; every function takes a transaction client |
| Views | `backend/src/views/` | Domain object → the exact response body the API has always returned |
| Event handlers | `backend/src/events/handlers/` | In-process replacements for the old Kafka consumers |

The old bounded contexts survive as **file groupings**, not processes: auth
(`auth.service`, `credentials.service`, `token-issuer.service`,
`token-denylist.service`), tenancy/onboarding (`organizations.*`, `onboarding.*`),
users (`users.*`, `invitations.*`), subscriptions (`subscriptions.*`, `plans.*`,
`usage.*`), resources (`resources.*`), audit (`audit.*` + the audit/security sinks).
A cross-module call is a plain function call — there is no gateway, no internal
HTTP, no signed internal header.

What replaced the infrastructure:

| Was | Now |
|---|---|
| Kafka topics + consumers | `lib/events` — an in-process bus. `publish()` after commit; handlers are awaited in-process, failures logged and swallowed, no retry/DLQ |
| Redis logout denylist | `revoked_access_tokens` table, checked on every authenticated request (fails **closed**), purged hourly |
| Redis-backed throttler | In-memory fixed window per process (same headers and 429 body; per-replica) |
| Redis onboarding claim | The `onboarding_sagas.idempotency_key` unique constraint (the Redis claim was only ever logged) |
| `consumed_events` dedupe tables | Gone — there is no redelivery to dedupe |
| 5 databases, per-service roles | One `app_db`, three roles: `app_migrator` (DDL), `app_user` (DML, `NOBYPASSRLS`), `app_rls_bypass` (`NOLOGIN`, owns the SECURITY DEFINER lookups) |

Only the backend (`127.0.0.1:3000`) and the frontend (`127.0.0.1:5178`) have
published ports; Postgres is reachable only on the internal Docker network.

---

## §13 / H1 — How tenant isolation actually works (PostgreSQL Row-Level Security)

This is the mechanism the frontend's `ResourceDetailPage` 404 (see Part B) is
*standing on top of* — worth understanding in full, because "RLS" as a phrase
undersells how specific and deliberate the implementation is.

### The chain, end to end

1. **The client sends a JWT.** Nothing else — no organisation ID in a header,
   body, or query param, anywhere, ever (§13.3 — no route accepts
   `organizationId` as an input).

2. **`middlewares/authenticate.ts` verifies the JWT** (signature, expiry, then the
   logout denylist) and opens **one scope** via Node's `AsyncLocalStorage`
   (`lib/context-store.ts`) carrying `{ userId, organizationId, roles,
   correlationId }` from the token's claims. This is the **one and only place** a
   client-supplied token becomes a trusted identity; no other layer reads identity
   from `req`. Public routes use `anonymous()` instead, which opens a scope with
   `userId` and `organizationId` both null.

3. **Every tenant query runs inside a `lib/tenant-db.ts` transaction.**
   `transaction(work)` opens a Prisma interactive `$transaction` and, as its first
   statement, runs

   ```sql
   SELECT set_config('app.current_org', $1, true)   -- true = transaction-local
   ```

   with the org from the scope. `set_config(..., true)` rather than `SET LOCAL`
   because `SET` cannot take a bind parameter, and an org id is not something to
   interpolate into SQL. Because it is transaction-local it can never leak onto
   the next request that reuses the pooled connection. The siblings
   `transactionForOrganization(orgId, work)` (event handlers, jobs),
   `transactionWithDeferredScope(work)` (invitation acceptance, which must look up
   the org first) and `runGlobal(work)` (the explicit, logged, unscoped escape
   hatch) cover every other case.

4. **PostgreSQL itself, not application code, filters every row.** Every tenant
   table has an RLS policy created in the same migration that creates the table
   (`backend/prisma/migrations/0001_init/migration.sql`):

   ```sql
   ALTER TABLE "resources" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "resources" FORCE ROW LEVEL SECURITY;   -- ← the load-bearing line
   CREATE POLICY tenant_isolation ON "resources"
     USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
     WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
   ```

5. **The backend refuses to run as a role that could bypass this.** At boot,
   `assertRlsSafeRole()` checks `pg_roles` for the connected role and exits if it
   is a superuser or has `BYPASSRLS`.

### Why `FORCE ROW LEVEL SECURITY` is the one line that makes this real

`ENABLE ROW LEVEL SECURITY` alone still lets the **table's owner** bypass the
policy — and in a naive setup, the app's own DB role often *is* the table owner.
`FORCE` closes that hole: the policy applies to *everyone*, including the owner,
including a migration role, including a query the app never intended to run. This
is the literal answer to the walkthrough's §7 Q1 — *"show me what happens if a
developer forgets the tenant filter on a new query"*:

> A careless `SELECT * FROM resources` with no `WHERE` clause at all still only
> returns the caller's own organisation's rows. There is no filter to forget — the
> database enforces it on every query issued in the scoped transaction, regardless
> of what that query's author intended, because `FORCE ROW LEVEL SECURITY` applies
> the policy unconditionally, and `USING (organization_id = current_setting(...))`
> is evaluated against **every row the query would otherwise have touched**.

`resources.service.ts` keeps a deliberately WHERE-less raw query,
`findAllResourcesForReport()`, purely so a test can demonstrate exactly this.

`WITH CHECK` is the write-side twin: without it, a malicious or buggy `INSERT`
could plant a row with someone else's `organization_id` even though the RLS
`USING` clause would later hide that row from everyone else's `SELECT`s — `WITH
CHECK` rejects the write itself if the row being written doesn't match the current
scope.

### The `NULLIF(..., '')` detail — a real, subtle bug this codebase already fixed once

`current_setting('app.current_org', true)` returns an **empty string**, not SQL
`NULL`, once a transaction that set it commits (a transaction-local setting reverts
to `''`, not back to unset, on a pooled connection). Casting `''::uuid` directly
**raises an error** rather than returning zero rows. `NULLIF(x, '')` converts that
empty string back to a genuine `NULL` before the cast, so a connection that hasn't
(yet) opened a tenant scope correctly evaluates to "matches nothing" — zero rows,
not a crash. The same property is why a platform admin (organizationId null → no
scope set) sees zero tenant rows without any special-casing in application code.

### The cross-tenant *detection* functions — proving "not readable" vs "doesn't exist"

The migration also creates narrow `SECURITY DEFINER` functions —
`resource_exists(uuid)`, `user_exists(uuid)`, plus the org-id lookups
`get_user_organization_id`, `get_invitation_organization_id` and the counters-only
`get_usage_aggregates` — owned by `app_rls_bypass` (which has `BYPASSRLS` but is
`NOLOGIN`: nothing can connect as it). `resource_exists` exists so the
cross-tenant probe in `resources.service.ts` can ask "does this ID exist *anywhere*?" — a question the
RLS-protected connection genuinely cannot answer, because a `FORCE`-protected table
with no scope set returns *zero rows for every ID*. When a scoped read of
`/resources/:id` or `/users/:id` finds nothing and the probe says the id exists
elsewhere, the service publishes `CrossTenantAccessAttempted` on `security.events`
— and still returns the **same 404** as a missing id.

---

## §19 / H2 — How the concurrency guarantee actually works

**The exact race the brief describes:** two simultaneous invite requests, each
individually within the remaining seat limit, that together would exceed it. The
requirement is that **only one may succeed**.

### The mechanism: `SELECT ... FOR UPDATE`, not a cache, not a distributed lock

`backend/src/services/users.service.ts`, `invite()`:

```ts
const invitationId = await transaction(async (tx) => {
  // Subscription row locked FIRST, always, for deadlock avoidance.
  const seat = await seats.lockForUpdate(tx, organizationId);

  if (seat.usedSeats >= seat.maxSeatsSnapshot) {
    throw new PlanLimitExceededException(/* ...specific message... */);
  }

  const invitation = await invitations.create(tx, organizationId, { ... });
  await seats.adjustUsedSeats(tx, organizationId, 1);
  return invitation.id;
});
```

`lockForUpdate` (`backend/src/models/subscription-seat.model.ts`) issues:

```ts
await db.$queryRaw`
  SELECT used_seats AS "usedSeats", max_seats_snapshot AS "maxSeatsSnapshot"
  FROM subscriptions
  WHERE organization_id = ${organizationId}::uuid
  FOR UPDATE
`;
```

**Why this actually prevents the race, concretely:** when two `invite()` calls hit
the same organisation at the same instant, the *second* transaction's
`FOR UPDATE` **blocks** — it does not proceed, does not read a stale count, does
not race — until the *first* transaction commits or rolls back. By the time the
second transaction's lock is granted, it reads the count **the first transaction
already updated**. There is no window in which both transactions see
"4 of 5 seats used" and both decide they're allowed to proceed.

Storage works the same way: `resources.service.ts` `create()` locks the
org's `plan_limit_cache` row `FOR UPDATE`, checks `used + size <= max`, inserts the
resource and increments the counter in one transaction. A plan downgrade
(`subscriptions.service.ts` `changePlan()`) locks the subscription row and checks
current usage against the *target* plan before writing. Prisma's interactive
transactions are configured with a 30 s timeout and 10 s max wait
(`lib/tenant-db.ts`), long enough for a queue of concurrent invites.

### The independent backstop: a CHECK constraint

Even if the lock were somehow bypassed by a bug, the table itself has:

```sql
CONSTRAINT "ck_subscriptions_seats" CHECK ("used_seats" <= "max_seats_snapshot")
```

If any code path ever tried to write `used_seats` past `max_seats_snapshot`,
PostgreSQL refuses the write outright — a second, independent line of defence that
doesn't depend on the application getting the lock right. `plan_limit_cache` and
`subscriptions` have the equivalent storage `CHECK`s.

### The proof — tests against a real PostgreSQL container

`backend/tests/integration/` spins up Postgres 17 in a Testcontainer (not mocked,
not a fake in-memory serialisation) with the production role layout, applies the
real migration, and runs the services **as `app_user`** (no superuser bypass). The
concurrency tests there fire genuinely concurrent invite transactions against a
nearly full organisation and assert that exactly the right number succeed, and that
the `CHECK` constraint rejects an over-limit write even without the lock.

The distinction between unit and integration tests matters here: a *unit* test
(`tests/unit/users.service.spec.ts`) proves the transaction's *shape* — lock, then
check, then write, in that order — but a unit test with a mocked model **cannot**
detect a missing `FOR UPDATE` clause. Only the real-Postgres test can catch that
regression, which is why both exist.

---

## §11 / §9.4 — One entry point, one JWT→context translation point

There is no separate gateway any more: the backend *is* the one published entry
point. What the gateway used to do is now ordinary middleware in `app.ts` and on
each route — helmet, a CORS **allowlist** (`CORS_ORIGINS`, never reflect-any-origin),
correlation-id minting/echoing, request logging, rate limiting and JWT
verification. The HMAC-signed internal context header and every `/internal/*`
endpoint are gone, because there is no second hop to authenticate.

`GET /dashboard` still combines two reads (the current subscription and the five
most recent users) into one response to save the frontend a request waterfall on
its most-visited screen — now two function calls, each behind its own CASL check,
rather than two downstream HTTP calls.

**Exactly four route groups skip JWT verification** (they run `anonymous()`
instead): `POST /auth/login`, `POST /auth/refresh`, `POST /onboarding/signup` and
`POST /invitations/:token/accept` — because you cannot authenticate to
authenticate, a new organisation has no account yet, and an invitee has no account
yet. The two health probes are public too, and return booleans only. Every other
route requires a verified identity (`backend/src/routes/index.ts` lists them).

---

## §3.5 (audit) — The trail is append-only because there's no way to write it any other way

There is **no write route** for audit data — the audit controller only lists.
Every audit and security row is written by the in-process event sinks
(`backend/src/events/handlers/audit-sink.handler.ts` and
`security-events.handler.ts`), which receive every event published on the
`organization/user/subscription/resource` and `security` channels. Onboarding,
plan-limit rejections, and cross-tenant access attempts all publish events that land
here.

It is also append-only at the database level: `app_user` has only `SELECT, INSERT`
on `audit_events` and `security_events` — no `UPDATE`, no `DELETE` — so even a bug
in the application cannot rewrite history. Both tables are FORCE-RLS with a variant
policy that admits NULL-org (platform-level) rows only while no org scope is set.

Trade-off accepted with the move off Kafka: events are dispatched in-process after
commit and a failed handler is logged and dropped (no retry, no DLQ). The request
that produced the event never fails because of it.

---

# Part B — Frontend

## §3.1 — Organisations and users

**Requirement:** each org has its own users and data; a user of one org must never
see another org's data, even by a well-formed request for a resource by ID.

### What's built

| Piece | File | What it does |
|---|---|---|
| Wire types | [`src/types/api.ts`](frontend/src/types/api.ts) | `SessionUser.organizationId: string \| null` — mirrors the backend's `LoginResponseDto` exactly. `null` is the signal for a platform admin. |
| Session state | [`src/contexts/AuthContext.tsx`](frontend/src/contexts/AuthContext.tsx) | Holds the logged-in user's identity in React state, restored from `sessionStorage` on reload via a **lazy `useState` initializer** (`readInitialUser`, line 63) rather than an effect — see "Corrections" below for why. |
| Role derivation | `AuthContext.tsx` → `derivePlatformAdmin()` (line ~56) | Derives `isPlatformAdmin` the *same way the backend does* — `organizationId === null` — never invents a separate frontend notion of the role. |

**The critical thing this section is NOT allowed to do:** decide who can see what.
`AuthContext` only decides what to *render* (which menu items, which route). Every
actual data boundary is enforced server-side by Postgres RLS — the frontend has no
opinion on it. This is stated explicitly in the route guards:

```ts
// src/components/common/protected-route/ProtectedRoute.tsx
/**
 * Route guards decide what to RENDER. They do not decide what is permitted.
 * ...Hiding a route is UX; the server is the control.
 */
```

---

## §3.2 — Self-service onboarding (and "what if it fails partway")

**Requirement:** a new org can sign itself up with no engineering involvement; a
partial failure must not block a retry or leave orphaned data.

### What's built

| Piece | File | What it does |
|---|---|---|
| Signup page | [`src/pages/signup/SignupPage.tsx`](frontend/src/pages/signup/SignupPage.tsx) | Form for org name + first admin's name/email/password. |
| Zod schema | [`src/schemas/auth.ts`](frontend/src/schemas/auth.ts) → `signupSchema` | Mirrors the backend's `SignupDto` (`backend/src/dtos/onboarding.dto.ts`) validators field-for-field (min lengths, password ≥12 chars). |
| **The retry-safety mechanism** | `SignupPage.tsx` line 31 | `const [idempotencyKey] = useState<string>(generateIdempotencyKey);` |

**How the retry-safety actually works, line by line:**

```ts
// generateIdempotencyKey() — src/lib/utils.ts
export const generateIdempotencyKey = (): string => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};
```

This runs **once**, the moment the signup page mounts, and is stored in React state
so it survives every re-render of the form. Every submit — including a *retry* after
a failed first attempt — sends this **same key** as part of the payload:

```ts
// SignupPage.tsx onSubmit
const result = await signup({ ...values, idempotencyKey }).catch(() => null);
```

Why this matters for §3.2's "what happens if onboarding fails partway through":
if the backend creates the organisation row but then crashes before creating the
admin user, and you click "Create organisation" again, the **same key** arrives.
The backend (`services/onboarding.service.ts`) recognizes it as the same attempt (not a new signup) and resumes
rather than creating a second, duplicate organisation. If the key regenerated on
every submit, every retry would look like a brand-new signup attempt — which is
exactly the "orphaned data" failure mode the brief calls out.

The backend's own half is a saga table (`onboarding_sagas`) with a **unique**
constraint on this same idempotency key — that constraint, not any cache, is what
guarantees one saga per key. A failed step leaves the saga at the last step that
succeeded and the retry resumes from there (forward recovery). The frontend's job
was simply to generate the key once and hold it.

---

## §3.3 — Plans and limits, including the concurrency case

**Requirement:** plans define hard limits (seats, storage); an action that would
breach a limit is refused with a *specific* message; two simultaneous requests that
would each fit alone but together exceed the limit must not both succeed.

### What's built

**The frontend does none of the actual enforcement** — that's a Postgres row lock
on the `subscriptions` row (`SELECT … FOR UPDATE`, Part A), which predates my work and isn't
something the client can see or influence. What the frontend *does* own:

| Piece | File | What it does |
|---|---|---|
| Usage meter | [`src/components/common/usage-meter/UsageMeter.tsx`](frontend/src/components/common/usage-meter/UsageMeter.tsx) | Draws a seats/storage bar that turns amber at 80%, red at 100% — **purely informational**. |
| Verbatim error surfacing | [`src/hooks/usePlanLimitError.ts`](frontend/src/hooks/usePlanLimitError.ts) | The piece that actually satisfies §3.3's "clear, specific message" requirement. |

**The important line**, because it's easy to get backwards:

```ts
// src/hooks/usePlanLimitError.ts
export const showMutationError = (error: unknown, fallback = LABELS.COMMON.GENERIC_ERROR): void => {
    if (isPlanLimitError(error)) {
        toast.error(getErrorMessage(error, fallback), { duration: 8000 });   // ← no fallback used
        return;
    }
    toast.error(getErrorMessage(error, fallback));
};
```

When the server refuses an invite with a 409, it writes a message like *"Inviting
this user would exceed the Free plan's limit of 3 seats"*. That string is shown
**verbatim** — the frontend never substitutes its own generic "something went
wrong." Replacing a specific server message with a friendly local one would
silently defeat the brief's requirement, so the code comment says so directly:

```ts
// Requirement R6 asks for a clear, specific refusal — so a specific server
// message always wins over the fallback.
```

**The UsageMeter's colour is explicitly NOT the control:**

```ts
// UsageMeter.tsx
/**
 * The colour change at 80% is a COURTESY, not a control: the server refuses the
 * action, and it refuses it at 100%. A user who ignores an amber bar is stopped
 * by a 409 with a specific message, not by this component.
 */
```

This distinction matters for the walkthrough question in §7: *"a test proving the
concurrency guarantee holds"* — that test lives in the backend (two simultaneous
invite requests, in `backend/tests/integration/`), not in the frontend code,
because the frontend has no way to *cause* concurrency to matter — it just displays
whatever the server ends up saying.

---

## §3.4 — Organisation administration (invite / remove / role-change)

**Requirement:** org admins manage their own org's users; an org admin can only
ever affect users within their own organisation, including an attempt aimed at a
user in another org by ID.

### What's built

| Piece | File | What it does |
|---|---|---|
| Users list + table | [`src/pages/users/UsersPage.tsx`](frontend/src/pages/users/UsersPage.tsx) | Server-paginated table (cursor-based, never "load everything") |
| Invite dialog | [`src/pages/users/InviteUserDialog.tsx`](frontend/src/pages/users/InviteUserDialog.tsx) | Email + role form; shows the seat meter *before* the attempt |
| Role change | `UsersPage.tsx` → inline `<Select>` per row | `useUpdateUserRole()` mutation |
| Remove user | `UsersPage.tsx` + [`src/components/common/confirm-dialog`](frontend/src/components/common/confirm-dialog/ConfirmDialog.tsx) | Confirmation dialog before a destructive action |

**Why the frontend does nothing special for "can only affect their own org's
users":** there is no code here that checks "is this user ID in my organisation?"
— and there's deliberately no such check. Every mutation (`usersApi.updateRole`,
`usersApi.remove`) just sends the ID the admin clicked on. If that ID happened to
belong to another organisation (which the UI can't even construct, since the list
itself only ever shows the caller's own org's users), the request would come back
**404** from the backend's RLS — the exact same "does not exist" answer as the
H1 case below. The comment in the hook says this outright:

```ts
// src/hooks/users/queries.ts
/**
 * A 404 here is the expected answer for an id belonging to another organisation
 * ... Retrying would be pointless: RLS will filter the row out every time.
 */
```

---

## §3.5 / §13 — Tenant isolation, and the H1 hard case

**This is the sharpest requirement in the whole brief, so it gets the most detail.**

**Requirement:** *"a user of one organisation must never be able to see another
organisation's data, under any request — including a well-formed request for a
resource by ID that happens to belong to a different organisation."*

### The architecture (backend, predates my work, but essential context)

Tenant isolation is **not** a `WHERE organization_id = ...` clause anyone writes.
It's PostgreSQL Row-Level Security (RLS): every tenant table has a policy that
filters rows based on a session variable (`app.current_org`), set once per
transaction from the organisation in the **verified JWT** — and only
`middlewares/authenticate.ts` ever turns a token into that context. A developer
writing a brand-new, careless `SELECT * FROM resources` cannot bypass this — the
database itself refuses to return rows for the wrong tenant, structurally, not by
convention.

### What the frontend does with this

| Piece | File | What it does |
|---|---|---|
| Resource list | [`src/pages/resources/ResourcesPage.tsx`](frontend/src/pages/resources/ResourcesPage.tsx) | Only ever lists the caller's own org's resources (server enforces this) |
| **The H1 target** | [`src/pages/resources/ResourceDetailPage.tsx`](frontend/src/pages/resources/ResourceDetailPage.tsx) | Fetch a resource by ID — this is the exact page you'd navigate to if you tried `localhost:5173/resources/<some-other-orgs-id>` |

**Read the actual code, because the comment is the point:**

```ts
// src/pages/resources/ResourceDetailPage.tsx
/**
 * H1 — the sharpest cross-tenant case in this system, seen from the client.
 *
 * Paste another organisation's resource id into this URL and the screen below
 * renders "does not exist". No check in this component produced that: the request
 * went out well-formed, resource-service ran its query, and PostgreSQL row-level
 * security had already removed the row from what that query could see.
 *
 * That is why the not-found copy does not hedge with "you don't have permission" —
 * phrasing it that way would confirm the id exists somewhere, which is exactly the
 * information a tenant boundary is supposed to withhold.
 */
```

And the actual branch that handles it:

```ts
if (isError) {
    if (getErrorStatus(error) === 404) {
        return (
            <PageNotFoundState
                title={LABELS.RESOURCES.NOT_FOUND}         // "That resource does not exist."
                body={LABELS.RESOURCES.NOT_FOUND_BODY}
                action={backLink}
            />
        );
    }
    return <PageErrorState onRetry={() => void refetch()} />;  // a REAL error (5xx) looks different
}
```

Notice the distinction: a 404 gets a calm "doesn't exist" screen (expected,
correct behaviour). A 500 gets the generic error screen with a retry button
(unexpected, actually broken). The code treats these as **different categories of
outcome**, which is what lets a real test assert on it — see below.

### The test that proves it

[`src/pages/resources/__tests__/ResourceDetailPage.test.tsx`](frontend/src/pages/resources/__tests__/ResourceDetailPage.test.tsx) —
3 tests:

1. A mocked 404 renders "That resource does not exist" — **and asserts the generic
   error text does NOT appear**, so this test would fail if someone "simplified"
   the error handling into one generic branch.
2. A mocked 500 renders the actual error state (proves the two paths are genuinely
   different, not the same code coincidentally producing similar text).
3. A successful fetch renders the resource's real name — the positive case, so the
   test isn't just checking failure paths.

### "What happens if a developer forgets the tenant filter on a new query" (§7 walkthrough Q1)

This is a backend-architecture answer, not a frontend one, but it's worth stating
plainly since it's the second half of the sharpest walkthrough question: **it's
structurally impossible to forget**, because there is no filter to remember. RLS is
enabled and *forced* (`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`) on
every tenant table at the migration that creates it — even the table's *owner* role
can't bypass it. A careless new query still goes through the same Postgres
connection, which still has `app.current_org` set for this request, so the policy
applies regardless of what the query's author intended.

---

## §3.5 (platform admin) / §13.6 — Metadata only, never content

**Requirement:** a platform admin sees organisations + plan + aggregate usage, but
**never** any organisation's actual content — and this has to be a real boundary,
not just something the UI doesn't happen to link to.

### What's built

This is the one place where the *file structure itself* is the enforcement
mechanism, not just a runtime check.

| Piece | File | What it does |
|---|---|---|
| Admin shell | [`src/layouts/AdminLayout.tsx`](frontend/src/layouts/AdminLayout.tsx) | The platform-admin page shell |
| Admin API calls | [`src/services/organizations/organizationsApi.ts`](frontend/src/services/organizations/organizationsApi.ts) → `platformAdminApi` | A **separate export** from the tenant-facing `organizationsApi` in the same file |
| Admin pages | `src/pages/admin/AdminOrganizationsPage.tsx`, `AdminOrganizationDetailPage.tsx`, `AdminSecurityPage.tsx` | Every cell renders a count or a status string — never a resource, a user's name, or an audit payload |

**Read `AdminLayout.tsx`'s own doc comment — this is the actual argument for why
the boundary holds:**

```ts
/**
 * NOTE WHAT THIS FILE DOES NOT IMPORT: no resources feature, no users feature, no
 * audit feature, no tenant hook, no tenant API module. That is deliberate and it
 * is the frontend half of the §13.6 boundary — a platform admin can see that
 * organisations exist, what plan each is on and how much it uses, and nothing
 * else. Because the admin pages share no module with the tenant pages, a content
 * component cannot be mounted here by accident; it would have to be imported on
 * purpose, and the import would be visible in review.
 */
```

Concretely: `AdminOrganizationsPage.tsx` imports `useAdminOrganizations` and
`useAdminUsage` — both of which call `platformAdminApi`, which only has
`listOrganizations`, `getOrganization`, and `getUsage` (aggregate seats/bytes). It
does **not** have access to `resourcesApi`, `usersApi`, or `auditApi` — those
modules exist, but nothing in the `src/pages/admin/` tree imports them, and if it
did, that import would be a one-line diff a reviewer would immediately flag.

The router encodes the same separation — `src/routes/index.tsx` has two route
trees (`TenantRoute` and `PlatformAdminRoute`) that **share zero page components**:

```tsx
// tenant tree
{ element: <TenantRoute />, children: [{ element: suspense(<Pages.TenantLayout />), children: [...] }] }
// admin tree — entirely separate
{ element: <PlatformAdminRoute />, children: [{ element: suspense(<Pages.AdminLayout />), children: [...] }] }
```

### "Prove it" (§7 walkthrough Q3)

The proof is: open `AdminOrganizationsPage.tsx` and `AdminOrganizationDetailPage.tsx`
and try to find a line that renders a resource name, a file, a user list, or an
audit payload. There isn't one — `AdminOrganizationDetailPage.tsx` renders exactly
four things: org name, slug, status badge, and a `UsageMeter` for seats/storage.
That's the entire screen.

---

## §3.6 — Tenant context enforcement, seen from the client side

**Walkthrough Q2:** *"Where does tenant context come from, and where is it
applied — every service method, or one place?"*

Part A above answers this in full on the backend side. From the frontend's point
of view, the entire mechanism reduces to one fact: the SPA sends **only**
`Authorization: Bearer <JWT>` — nowhere in this codebase does the client construct,
send, or even hold an `organizationId` as a request parameter. `SessionUser.organizationId`
(`src/types/api.ts`) exists purely for the frontend's own *rendering* decisions —
which nav items to show, which route guard applies — never as something re-sent to
the server. The server derives the real, trusted `organizationId` entirely from the
verified JWT, at exactly one point (`middlewares/authenticate.ts`,
Part A), and the frontend has no path around that even if it wanted one.

---

# Part C — Two real backend bugs found while wiring the frontend to it

> **Historical.** Both bugs were in the original NestJS microservice backend
> (`libs/tenant-context`, `libs/authorization`), which no longer exists. In the
> Express monolith the equivalent code is `middlewares/authenticate.ts` (which opens
> the ALS scope itself, so there is no middleware-before-guard ordering to get wrong)
> and `lib/casl.ts` (which uses `createMongoAbility` from the start). The lessons
> stand; the file paths below do not.

I only found these because I actually clicked through the frontend and watched
`/dashboard` and `/organizations/me` both 500. Neither was a frontend bug — both
were in the backend's tenant-context plumbing described in Part A, both were
**completely untested** before this (0 unit tests on either class), and both are
now fixed with 20 new tests covering exactly the failure mode.

### Bug 1 — the ALS scope was never actually opened

`libs/tenant-context/src/middleware/tenant-context.middleware.ts` used to trust
that a *guard* (`InternalContextGuard`) had already verified the signed header and
attached it to the request. But in NestJS, **Express middleware always runs before
every guard** — so that field was always `undefined`, the scope was never opened,
and the very next guard in the chain (`CaslAbilityGuard`) crashed with
`TenantContextStore.getOrThrow() called outside a scoped request` on literally
every non-health-check request across all six downstream services.

Fixed by moving signature verification directly into the middleware — the only
place in Nest's pipeline that can wrap every guard, pipe, interceptor and handler
that runs after it. A second, smaller bug surfaced *while fixing this one*: the
health-check exemption used `req.path`, which Nest's `forRoutes('*')` middleware
sees rewritten to `"/"` (verified empirically against a real running app) —
corrected to `req.originalUrl`.

### Bug 2 (found immediately after fixing #1) — CASL had no way to evaluate its own rules

`libs/authorization/src/factory/casl-ability.factory.ts` built its permission
rules with plain CASL `Ability`, but every non-platform-admin rule uses a field
condition like `{ organizationId: ctx.organizationId }` — and evaluating *any*
condition requires a "conditions matcher," which plain `Ability` doesn't have. The
very first time a real request reached this code (which bug #1 had been silently
preventing until then), it threw `Cannot restrict access by conditions without a
"conditionsMatcher" option`. Fixed by switching to `createMongoAbility`, plus
correcting the CASL type definitions (`ForcedSubject` per literal, with real field
shapes) so the whole thing type-checks under strict `tsc` again.

**Why this matters for the brief, not just as a bugfix log entry:** these two bugs
together meant that, before this session, **every single authenticated,
tenant-scoped request in the entire system was broken** — `/organizations/me`,
`/dashboard`, `/users`, `/resources`, everything except the three `@Public()` auth
routes and health checks. The H1 and H2 mechanisms described in Part A were
correctly *designed* but had never actually been exercised end-to-end through a
real client, because nothing had tried until the frontend did. This is the
concrete argument for why the frontend integration was worth doing carefully
rather than mocking the backend: **it found two production-blocking defects that
193 passing backend tests had never touched.**

---

## §6 — Things this POC gets checked for, mapped to what exists

| Check in the brief | What satisfies it |
|---|---|
| Bad input rejected before business logic | **Backend:** every DTO uses `class-validator` decorators (`@IsEmail`, `@MinLength`, etc.), validated by the `validateBody` / `validateQuery` route middleware (`middlewares/validate.ts`, `whitelist` + `forbidNonWhitelisted`) before any controller runs. **Frontend:** every form uses a Zod schema mirroring that same DTO (`src/schemas/auth.ts`, `users.ts`, `resources.ts`) — a convenience only; the server validates independently, always |
| No anonymous path beyond onboarding | **Backend:** exactly four public routes (`/auth/login`, `/auth/refresh`, `/onboarding/signup`, `/invitations/:token/accept`) plus the two boolean health probes; every other route requires a verified JWT. **Frontend:** `ROUTES` splits into `PublicOnlyRoute` vs `ProtectedRoute`/`TenantRoute`/`PlatformAdminRoute` |
| The H1 test | **Backend:** RLS + `FORCE ROW LEVEL SECURITY` (Part A) is the actual enforcement. **Frontend:** `ResourceDetailPage.test.tsx` (3 tests) proves the client-visible behaviour |
| The H2 concurrency test | `backend/tests/integration/` — concurrent invite transactions against a real PostgreSQL container as `app_user`, plus the `CHECK`-constraint backstop |
| Lists stay usable as data grows | Keyset cursor pagination end to end: backend models return `{ items, nextCursor }` from an indexed `(organization_id, created_at DESC, id)` query, never a `COUNT(*)`; frontend's `useCursorPagination.ts` consumes it with Previous/Next only — no page numbers |
| Structured trace for cross-tenant attempts | **Backend:** there is no audit write route at all — every event reaches the in-process audit/security sinks, and `app_user` can only `SELECT`/`INSERT` the audit tables. **Frontend:** `AuditPage.tsx` (org's own trail) + `AdminSecurityPage.tsx` (platform-wide security events, metadata only) |
| `docker compose up`, no manual setup | Backend: one-shot `migrator` container runs `prisma migrate deploy` + the platform-admin seed before the backend starts. Frontend: `frontend/Dockerfile` (pnpm build → nginx static serve) + the `frontend` service block in `docker-compose.yml` — four containers, two published ports |

---

## What's genuinely NOT built (be upfront about this)

- The §8 "internal tenant-leak-detection tool" (a small tool scanning for
  resources whose foreign keys resolve to a different organisation than their
  owner) is not built — `resource_exists()` (Part A) is the *primitive* such a
  tool would use, but the tool itself doesn't exist yet.
- Event delivery is best-effort: in-process, after commit, no retry or DLQ. A
  handler that throws (e.g. the audit insert for a non-UUID `x-correlation-id`) is
  logged and dropped.
- Rate limiting is per process — correct for the single-replica POC, N× too
  generous with N replicas.
- Behaviours intentionally carried over unchanged from the old stack (documented
  follow-ups, not fixed in the rewrite) are listed in ARCHITECTURE.md's
  "Current implementation" section.
- Email delivery for invitations is stubbed (§8.2's `tokenForDev` — the raw
  invitation token is returned directly in the API response in development,
  rather than emailed) — a known, documented MVP shortcut, not something either
  of us built around.
