# Multi-Tenant Subscription Management — Technical Architecture

**Status:** Design — approved for implementation
**Phase:** Architecture only. No application code, entities, migrations or installed packages exist yet.
**Source of truth for requirements:** `docs/architecture/POC-BRIEF.md`

---

## 1. Project Overview

A product serves several client organisations from one deployment. Today, in the problem this POC
addresses, there is no real wall between those organisations: a query missing a filter leaks one
organisation's data into another's response, plan limits exist only as a number in a spreadsheet
nobody enforces, and onboarding a new client means an engineer creating rows by hand.

This system fixes all three:

1. **Every organisation's users and data are isolated from every other's as a property of the
   architecture** — not as a property of every engineer remembering to write `WHERE tenant_id = …`.
2. **Plans define hard limits that are actually enforced**, including under real concurrency.
3. **A new organisation can onboard itself** without a support ticket.

The centre of gravity is requirement 1. Everything else in this document is subordinate to it.

### The two hard cases

The architecture is designed around two specific failure modes that are easy to get wrong:

| # | Hard case | Where it is solved |
|---|---|---|
| **H1** | A user of Org A issues a *well-formed* request for a resource by ID that belongs to Org B. It must fail — and it must fail even if the developer who wrote that endpoint forgot to scope the query. | §13 Tenant Isolation |
| **H2** | Two invite requests arrive simultaneously. Each individually fits the remaining seat limit; together they exceed it. Exactly one must succeed. | §19 Concurrency |

A reviewer should be able to read §13 and §19 alone and understand the whole design's reason for
existing.

---

## 2. POC Requirements Summary

Condensed from the brief. The brief remains the spec; this is an index.

### 2.1 Actors

| Role | Can do |
|---|---|
| **Platform Admin** | View organisations, their plan and aggregate usage. **Cannot view any organisation's content.** |
| **Org Admin** | Manage their own organisation's users and roles; view their own usage against plan limits. |
| **Org Member** | Use the product within their organisation; see only their own organisation's data. |

### 2.2 Functional requirements

| Ref | Requirement |
|---|---|
| R1 | Each organisation has its own users and data. A user belongs to exactly one organisation. |
| R2 | **A user of one org must never see another org's data — including a well-formed request for a resource by ID belonging to a different org.** |
| R3 | Self-service onboarding creates the organisation, its first admin user, and a default plan assignment, with no engineering involvement. |
| R4 | Onboarding that fails partway must not leave a half-created organisation that blocks retry or orphans data. |
| R5 | Plans define limits: maximum user count and maximum storage. |
| R6 | An action exceeding a limit is refused with a **clear, specific** message — not a generic error, not a silent partial success. |
| R7 | **Two simultaneous requests that each individually fit but together exceed the limit must not both succeed.** |
| R8 | Org admins manage only their own org's users, including when reaching another org's user by ID. |
| R9 | Platform admins see org list + plan + aggregate usage, but no content. A route that happens to expose content is a failure even if nothing in the UI links to it. |
| R10 | Tenant scoping applied through a single enforced mechanism, demonstrably resilient to a developer who forgets to scope a new query. |

### 2.3 What the POC is explicitly checked for

- Bad input (malformed email, non-existent plan) rejected **before** reaching business logic.
- No anonymous path through the system beyond the signup flow itself.
- A test proving cross-tenant read-by-ID fails, **plus** a demonstration of what happens when a
  developer forgets the tenant filter on a brand-new query.
- Plan-limit guarantee holding under real concurrency, with a test firing two simultaneous requests.
- Org list and per-org resource lists stay usable as data grows — no load-everything-and-filter-in-code.
- Onboarding, plan-limit rejections and cross-tenant access attempts leave a **structured trace**.
- The whole thing comes up with `docker compose up` and no manual setup beyond a documented `.env`.

---

## 3. Architecture Goals

| Goal | How it is met | Verified by |
|---|---|---|
| **G1 — Structural tenant isolation** | Four independent enforcement layers, the deepest being PostgreSQL Row-Level Security which no application code can forget | §13; the careless-query test |
| **G2 — Correct plan limits under concurrency** | Single ACID transaction, row lock, plus a database `CHECK` constraint as a backstop | §19; the 2-request and 50-request tests |
| **G3 — Clear service boundaries with owned data** | 7 services, each owning its schema; no arbitrary cross-service table reads | §7, §14, §21 |
| **G4 — Provable platform-admin content boundary** | Platform admin tokens carry no `orgId`, so RLS returns zero content rows by construction; no bypass flag exists in the codebase | §13.6 |
| **G5 — Structured, queryable traces** | Correlation ID minted at the gateway, propagated through REST and Kafka headers; three mandated trace points | §24 |
| **G6 — Reviewable simplicity** | Every service, container, dependency and event in this document carries a stated reason | §23 MVP rule |
| **G7 — Testability** | DI against interfaces, Testcontainers for real Postgres behaviour (RLS and locks cannot be mocked) | §28 |

---

## 4. Non-Goals

Explicitly out of scope. Naming these prevents scope creep and shows the boundaries were chosen,
not overlooked.

| Not doing | Why |
|---|---|
| Kubernetes, service mesh, Helm | `docker compose up` is the stated deployment target |
| Prometheus / Grafana / Elasticsearch / Jaeger | Structured JSON logs with correlation IDs meet the brief's traceability requirement at a fraction of the infrastructure |
| RabbitMQ | Kafka already covers the event backbone; two brokers is two brokers |
| Billing, payment processing, invoicing | Plans and limits are in scope; charging money is not |
| Multi-region, sharding, read replicas | §29 documents the path; the POC runs single-region |
| SSO / OAuth / SAML | Local credentials with Argon2 is sufficient to demonstrate the auth boundary |
| Email delivery | Invitations are modelled and audited; actual SMTP is stubbed and logged |
| A user belonging to multiple organisations | The brief states a user belongs to exactly one organisation; this materially simplifies the isolation model |
| Fine-grained per-field permissions | Three roles at resource granularity is the stated requirement |
| Prisma, Sequelize, Drizzle, Mongoose, or any ORM besides TypeORM | Hard constraint |
| Redux, Zustand, MobX | Server state is the only real state; TanStack Query owns it |

---

## 5. Technology Stack

Every entry has a reason. Versions are deliberately unpinned — implementation uses the latest
stable compatible release at that time.

### 5.1 Backend

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node.js LTS | — |
| Framework | **NestJS** | Built-in DI container, module boundaries, and first-class monorepo support for multiple apps |
| Language | TypeScript, `strict: true` | — |
| Package manager | **pnpm** (workspace) | Content-addressed store — 7 services sharing `libs/` without 7 copies of `node_modules`; strict by default, so a service cannot import an undeclared dependency |
| ORM | **TypeORM** — *the only ORM* | Hard constraint. Also: `DataSource.transaction` gives explicit transaction boundary control and `QueryRunner` access, which §19 requires |
| Database | **PostgreSQL** | Row-Level Security (§13) and `SELECT … FOR UPDATE` (§19) are both load-bearing and both PostgreSQL features |
| Event bus | **Apache Kafka** (KRaft mode) | Durable, ordered, replayable event log for audit (§17). KRaft removes the ZooKeeper container |
| Cache / ephemeral state | **Redis** | Rate-limit buckets, refresh-token store, idempotency keys (§16) |
| Auth | `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt` | Stated requirement |
| Password hashing | **Argon2** (`argon2`, Argon2id) | Stated requirement; memory-hard, current best practice |
| Authorisation | **CASL** (`@casl/ability`) | Stated requirement; declarative abilities, conditions on subject attributes |
| Validation | `class-validator` + `class-transformer` via global `ValidationPipe` | Rejects bad input before business logic — brief §6 |
| Security headers | `helmet` | Stated requirement |
| Rate limiting | `@nestjs/throttler` + Redis storage | Stated requirement; Redis storage so limits hold across replicas |
| Logging | `nestjs-pino` / `pino` | Structured JSON out of the box, low overhead |
| HTTP client | `@nestjs/axios` | Service-to-service REST with interceptors for context propagation |
| Testing | **Jest** + `@nestjs/testing` + **Testcontainers** | RLS policies and row locks cannot be mocked — they need a real PostgreSQL |

### 5.2 Frontend

| Concern | Choice | Reason |
|---|---|---|
| Framework | React + TypeScript | Stated requirement |
| Build | Vite | Stated requirement |
| Package manager | **pnpm** | Consistency with backend |
| Styling | Tailwind CSS | Stated requirement |
| Tables | TanStack Table | Stated requirement; headless, pairs with server-side pagination (§29) |
| Server state | TanStack Query | Caching, invalidation, request dedupe. **This is why no Redux is needed** — nearly all state here is server state |
| Routing | React Router | Route-level role guards |
| HTTP | Axios | Interceptors for token attach and refresh-on-401 |
| Forms | React Hook Form + Zod | Zod schemas mirror backend DTOs, so bad input is caught client-side too |
| Icons | lucide-react | Tree-shakeable |
| Class merging | clsx + tailwind-merge | The `cn()` helper every Tailwind design system needs |
| Testing | Vitest + React Testing Library | Stated requirement |

### 5.3 Explicitly rejected

`Prisma` / `Sequelize` / `Drizzle` / `Mongoose` (TypeORM only, hard constraint) · `Redux` /
`Zustand` / `MobX` (§4) · `RabbitMQ` (Kafka covers it) · `bcrypt` (Argon2 specified) ·
`moment` (native `Intl` / `date-fns` if genuinely needed) · any component library such as MUI or
shadcn-as-a-dependency (§22 builds a small set of primitives instead).

---

## 6. High-Level System Architecture

```
                        ┌────────────────────────────────┐
                        │   React SPA  (Vite · pnpm)     │
                        │   TanStack Query · RHF + Zod   │
                        └───────────────┬────────────────┘
                                        │  REST/JSON  ·  Authorization: Bearer <JWT>
                                        ▼
        ┌───────────────────────────────────────────────────────────────┐
        │                        api-gateway                            │
        │  helmet · CORS allowlist · throttler(Redis) · correlation-id  │
        │  JWT verification  →  mints signed x-internal-context         │
        │                   NO BUSINESS LOGIC                           │
        └───────────────────────────────┬───────────────────────────────┘
                                        │
                 REST + x-internal-context (HMAC-SHA256 signed)
                 { userId, orgId, roles, correlationId, exp }
                                        │
   ┌──────────┬──────────────┬──────────┴─────┬───────────────┬──────────────┐
   ▼          ▼              ▼                ▼               ▼              │
┌────────┐ ┌──────────┐ ┌──────────┐   ┌──────────────┐ ┌────────────┐      │
│ auth   │ │ tenant   │ │  user    │   │ subscription │ │  resource  │      │
│ service│ │ service  │ │ service  │◄─►│   service    │ │  service   │      │
└───┬────┘ └────┬─────┘ └────┬─────┘   └──────┬───────┘ └─────┬──────┘      │
    │           │            │  same-txn seat  │               │             │
    │           │            │  check (§19)    │               │             │
    ▼           ▼            └────────┬────────┘               ▼             │
┌────────┐ ┌──────────┐      ┌────────┴─────────┐      ┌─────────────┐      │
│auth_db │ │tenant_db │      │     core_db      │      │ resource_db │      │
│        │ │          │      │ schema: users    │      │             │      │
│        │ │          │      │ schema: subs     │      │             │      │
└────────┘ └──────────┘      └──────────────────┘      └─────────────┘      │
    │           │                     │                       │             │
    └───────────┴──────────┬──────────┴───────────────────────┴─────────────┘
                           │  produce (fire-and-forget, never blocks request)
                           ▼
              ┌─────────────────────────────┐
              │      Kafka  (KRaft)         │
              │  organization.events        │
              │  user.events                │
              │  subscription.events        │
              │  resource.events            │
              │  security.events            │
              │  *.dlq                      │
              └──────────────┬──────────────┘
                             │ consume
                             ▼
                     ┌───────────────┐      ┌──────────┐
                     │ audit-service │─────►│ audit_db │
                     └───────────────┘      └──────────┘

   Redis  ──  gateway rate-limit buckets
          ──  refresh-token store + access-token denylist
          ──  onboarding idempotency keys
          ──  cached usage read-model (DISPLAY ONLY — never the enforcement path)

   ALL tenant-owned tables:  ENABLE + FORCE ROW LEVEL SECURITY
   Services connect as a non-owner role → RLS cannot be bypassed by application code.
```

### 6.1 Request lifecycle (the path every authenticated call takes)

```
1. Browser          Authorization: Bearer <access JWT>
2. api-gateway      helmet → CORS → throttler(Redis) → correlation-id middleware
3. api-gateway      JwtAuthGuard verifies signature + expiry + denylist(Redis)
4. api-gateway      mints x-internal-context, HMAC-SHA256 signed with INTERNAL_SIGNING_SECRET
5. downstream svc   InternalContextGuard verifies HMAC → rejects 401 if absent/invalid/expired
6. downstream svc   TenantContextMiddleware stores {userId, orgId, roles, correlationId} in AsyncLocalStorage
7. downstream svc   ValidationPipe rejects malformed DTO  ← bad input dies here, before business logic
8. downstream svc   CaslAbilityGuard checks "may this role perform this action?"
9. downstream svc   Application service opens a transaction
10. TenantDataSource issues SET LOCAL app.current_org = <orgId>   ← automatic, not per-query
11. PostgreSQL      RLS policy filters every row of every tenant table
12. response        exception filter shapes errors; pino logs with correlationId
```

Steps 4, 5, 6, 10 and 11 are the isolation chain. Step 11 is the one no developer can forget.

---

## 7. Microservices Breakdown

### 7.1 Decomposition principle

Services are drawn along **security and lifecycle boundaries**, not along entity boundaries. The
question asked of each candidate was: *does this own a distinct kind of data, with a distinct
failure and access profile, that a reviewer would expect to be separable?*

Seven services, all of which earn their place:

| # | Service | One-line responsibility |
|---|---|---|
| 1 | `api-gateway` | Single entry point; the only place a client JWT is verified and internal context is minted |
| 2 | `auth-service` | Credentials and tokens — "who is this user?" |
| 3 | `tenant-service` | Organisations and the onboarding saga — the isolation root |
| 4 | `user-service` | Org membership, roles, invitations — and the seat-limit transaction |
| 5 | `subscription-service` | Plans, limits, subscriptions, usage counters |
| 6 | `resource-service` | The tenant business resource that counts against storage limits |
| 7 | `audit-service` | Append-only audit and security event log |

### 7.2 Why not fewer

- Merging `auth-service` into `user-service` would put password hashes in the same schema as
  profile data. Credentials have a different blast radius; keeping them separate means a bug in
  user listing cannot expose a hash.
- Merging `audit-service` into anything makes the audit log mutable by the service being audited.
  An append-only log owned by a service that only ever consumes is the point.
- Merging `tenant-service` into `user-service` puts the onboarding saga — which orchestrates three
  other services — inside a service that is itself a saga participant.

### 7.3 Why not more

Candidates deliberately **not** created:

| Rejected service | Why not |
|---|---|
| `notification-service` | Email is stubbed in this POC (§4). Zero behaviour to own. |
| `usage-service` | Usage counters live with the limits they are compared against. Splitting them re-creates the distributed-transaction problem §19 exists to avoid. |
| `billing-service` | Out of scope (§4). |
| `reporting-service` | Would have no data of its own; every read is another service's data. |
| `file-storage-service` | Storage-limit accounting is `resource-service`'s job; actual blob storage is not in scope. |

---

## 8. Service Responsibilities

Full specification for each service. Each states: why it exists, what it owns, its API, its events,
and why the boundary is right **for this POC specifically**.

---

### 8.1 `api-gateway`

**Why it exists.** There must be exactly one place where a client-supplied JWT becomes trusted
internal context. If each service verified client JWTs independently, "who mints `orgId`?" would
have seven answers, and seven chances to get it wrong. It also gives the system one place for CORS,
rate limiting, security headers and correlation-ID minting.

**Owns.** No database. Deliberately stateless (touches Redis for rate-limit buckets and the token
denylist, but owns neither).

**Exposes.** The entire public API surface; routes to downstream services. Representative:

| Method | Path | Routes to | Auth |
|---|---|---|---|
| POST | `/api/v1/auth/signup` | tenant-service (onboarding saga) | **public** |
| POST | `/api/v1/invitations/:token/accept` | user-service | **public** (token is the credential) |
| POST | `/api/v1/auth/login` | auth-service | **public** |
| POST | `/api/v1/auth/refresh` | auth-service | public (refresh token) |
| POST | `/api/v1/auth/logout` | auth-service | authenticated |
| GET | `/api/v1/organizations/me` | tenant-service | Org Admin, Org Member |
| GET | `/api/v1/organizations` | tenant-service | **Platform Admin only** |
| GET/POST/PATCH/DELETE | `/api/v1/users…` | user-service | Org Admin (mutations), Org Member (self) |
| GET | `/api/v1/plans` | subscription-service | authenticated |
| GET | `/api/v1/subscriptions/current` | subscription-service | Org Admin, Org Member |
| POST | `/api/v1/subscriptions/change` | subscription-service | Org Admin |
| GET/POST/DELETE | `/api/v1/resources…` | resource-service | Org Admin, Org Member |
| GET | `/api/v1/audit` | audit-service | Org Admin (own org), Platform Admin (metadata) |

**Publishes / consumes.** Neither. The gateway is not a Kafka participant — it has no domain events
of its own, and giving it any would be business logic.

**Communicates via.** REST to all downstream services, with the signed `x-internal-context` header.

**Why this boundary is right for the POC.** The brief demands there be "no anonymous path through
this system beyond the onboarding/signup flow itself". A single gateway makes that claim auditable:
exactly four business routes are marked `@Public()` (§11.5), and they are visible in one file —
plus the two health-check paths, exempted on separate, narrower grounds (§26.4) and excluded from
this count since they carry no business logic and return only a liveness/readiness boolean.

**Hard rule.** No business logic. No database. No entity. If a change to the gateway requires
knowing what a subscription *is*, it belongs downstream.

---

### 8.2 `auth-service`

**Why it exists.** Credentials are a distinct security boundary from profile data. This service is
the only component that ever sees a password, and the only one that mints tokens.

**Owns — `auth_db`:**

| Table | Contents |
|---|---|
| `credentials` | `id`, `user_id`, `organization_id` (nullable — platform admins have none), `email` (citext, unique), `password_hash` (Argon2id), `status`, timestamps |
| `refresh_tokens` | `id`, `credential_id`, `token_hash`, `expires_at`, `revoked_at`, `replaced_by` |

**Exposes:**

| Method | Path | Purpose |
|---|---|---|
| POST | `/internal/auth/credentials` | Create credentials (called by tenant-service during onboarding). **Mints and returns `userId`** — never accepts one (§11.3) |
| POST | `/auth/login` | Email + password → access + refresh token |
| POST | `/auth/refresh` | Rotate refresh token → new access token |
| POST | `/auth/logout` | Revoke refresh token, add access token JTI to Redis denylist |

**Publishes:** `UserCredentialsCreated` → `user.events`.

**Consumes:** `OrganizationDeleted` → revoke all credentials for that org.

**Why this boundary is right for the POC.** The JWT it mints is where `orgId` enters the system.
That claim is the root of the entire isolation chain in §13, so it deserves an owner that does
nothing else.

---

### 8.3 `tenant-service`

**Why it exists.** The organisation *is* the tenant — the isolation root that every other service's
data hangs from. It also owns self-service onboarding, which orchestrates three services and must
survive partial failure (R4).

**Owns — `tenant_db`:**

| Table | Contents |
|---|---|
| `organizations` | `id`, `name`, `slug` (unique), `status` (`provisioning` / `active` / `provisioning_failed` / `suspended`), timestamps |
| `onboarding_sagas` | `id`, `idempotency_key` (unique), `organization_id`, `state`, `admin_email`, `last_error`, `attempts`, timestamps |

`organizations` is **not** RLS-protected — it is the tenant registry itself, read by platform admins
and by each org for its own row, guarded by CASL and an explicit `id = ctx.orgId` check (§13.6).

**Exposes:**

| Method | Path | Purpose |
|---|---|---|
| POST | `/onboarding/signup` | **Public.** Runs the saga (§11.3) |
| GET | `/organizations/me` | Caller's own organisation |
| GET | `/organizations` | **Platform Admin.** Keyset-paginated list with plan + aggregate usage |
| GET | `/organizations/:id` | Platform Admin, metadata only |

**Publishes:** `OrganizationCreated`, `OrganizationProvisioned`, `OnboardingFailed`,
`OrganizationSuspended` → `organization.events`.

**Consumes:** nothing in the MVP (the saga uses synchronous REST because it must know each step
succeeded before advancing — §11.3).

**Why this boundary is right for the POC.** R9 demands a provable platform-admin/content boundary.
Platform admins read *only* from this service and from subscription aggregates. Because
`tenant_db` contains no organisation content at all, "platform admin cannot see content" is a
property of which database they can reach, not of a filter someone wrote.

---

### 8.4 `user-service`

**Why it exists.** Owns org membership, roles and invitations — and, critically, owns the
transaction that enforces the seat limit (H2/R7).

**Owns — `core_db`, schema `users`:**

| Table | Contents | RLS |
|---|---|---|
| `users` | `id`, `organization_id`, `email`, `first_name`, `last_name`, `role`, `status`, timestamps | **yes** |
| `invitations` | `id`, `organization_id`, `email`, `role`, `token_hash`, `expires_at`, `accepted_at` | **yes** |

**Exposes:**

| Method | Path | Purpose |
|---|---|---|
| POST | `/users/invite` | **The seat-limit path (§19.2).** Org Admin only. A pending invite holds a seat (D-Q1) |
| GET | `/users` | Keyset-paginated, RLS-scoped list |
| GET | `/users/:id` | **The cross-tenant read-by-ID path (H1).** 404 + security event on foreign ID |
| PATCH | `/users/:id/role` | Org Admin; cannot demote the last admin |
| DELETE | `/users/:id` | Org Admin; frees a seat |
| POST | `/invitations/:token/accept` | **Public.** Converts a held seat into a user — net zero (§19.8) |
| DELETE | `/invitations/:id` | Org Admin; revokes a pending invite and **releases its seat** |
| GET | `/internal/users/:id/role` | **Internal only.** Called by auth-service at login/refresh (§9.2, §11.2) so the JWT `roles` claim reflects the CURRENT role, not a cached one. The handler resolves `organization_id` via the narrow `SECURITY DEFINER` function documented in §13.6, since the caller has no tenant context to supply |

**Publishes:** `UserInvited`, `UserCreated`, `UserRemoved`, `UserRoleChanged`, `InvitationExpired`
→ `user.events`; `PlanLimitExceeded` → `subscription.events`;
`CrossTenantAccessAttempted` → `security.events`.

**Also owns the invitation-expiry sweep (D-Q7).** A scheduled job, running in this service, marks
invitations past `expires_at` as expired and releases their seats. It takes the **same subscription
row lock** as the invite path, so a sweep and an invite cannot race. It runs as a global operation
(`runGlobal()`, §15.3) iterating org by org, establishing tenant scope per organisation — it is the
one background job in the system, and it is deliberately scoped rather than granted a bypass.

**Consumes:** `OrganizationProvisioned` → create the first admin user row.

**Why this boundary is right for the POC.** Users are the thing counted against the seat limit and
the thing an org admin must not reach across tenants. Both hard cases run through this service, so
it gets the most test coverage.

---

### 8.5 `subscription-service`

**Why it exists.** Plans and limits have their own lifecycle — a plan catalogue changes
independently of any organisation. It owns the **subscription row that §19 locks**.

**Owns — `core_db`, schema `subs`:**

| Table | Contents | RLS |
|---|---|---|
| `plans` | `id`, `code` (`free`/`pro`/`enterprise`), `name`, `max_users`, `max_storage_bytes`, `is_active` | no — global catalogue, not tenant data |
| `subscriptions` | `id`, `organization_id` (**unique**), `plan_id`, `status`, `used_seats`, `used_storage_bytes`, `current_period_end`, `version` | **yes** |
| `subscription_history` | `id`, `organization_id`, `from_plan_id`, `to_plan_id`, `changed_by`, `changed_at` | **yes** |

`subscriptions` carries `CHECK (used_seats <= max_seats_snapshot)` and
`CHECK (used_storage_bytes <= max_storage_snapshot)` — the §19 backstop.

**Exposes:**

| Method | Path | Purpose |
|---|---|---|
| GET | `/plans` | Public catalogue |
| POST | `/internal/subscriptions` | Assign default plan (called by the onboarding saga) |
| GET | `/subscriptions/current` | Caller's subscription + live usage |
| POST | `/subscriptions/change` | Upgrade / downgrade. **A downgrade is a limit path (§19.10)** — blocked with a 409 if usage exceeds the target plan (D-Q4) |
| GET | `/internal/usage/aggregate` | Platform-admin aggregates — **counts only, never content** |

**Publishes:** `SubscriptionAssigned`, `SubscriptionChanged`, `UsageUpdated` → `subscription.events`.

**Consumes:** `ResourceCreated` / `ResourceDeleted` → reconcile `used_storage_bytes`;
`UserInvited` / `UserCreated` / `UserRemoved` / `InvitationAccepted` / `InvitationExpired` →
**drift detection only** for `used_seats`.

**`used_seats` is never written by a consumer.** It is maintained transactionally by `user-service`
inside the locked transaction that changes it (§19.4), because it is the authoritative enforcement
quantity. A consumer that recomputed it from `UserCreated`/`UserRemoved` alone would overwrite the
seats held by pending invitations and silently free them (D-Q1). The seat consumers therefore
*recompute and compare*: a mismatch is logged at `security` severity as evidence of a code path that
skipped the lock. `used_storage_bytes` has no such constraint and is reconciled normally.

**Note the split.** The Kafka consumers *reconcile* counters for display and drift detection. They
are **not** the enforcement path — enforcement is the synchronous transaction in §19. This
distinction is the single most important thing to preserve when extending this service.

**Why this boundary is right for the POC.** R9 requires platform admins to see plan and aggregate
usage but no content. This service's aggregate endpoint returns integers — there is no shape of
response it could return that would leak content.

---

### 8.6 `resource-service`

**Why it exists.** The brief requires a tenant-owned resource whose count or size counts against a
plan limit, and it is the natural target of the cross-tenant read-by-ID test.

**Owns — `resource_db`:**

| Table | Contents | RLS |
|---|---|---|
| `resources` | `id`, `organization_id`, `name`, `description`, `size_bytes`, `created_by`, timestamps | **yes** |
| `plan_limit_cache` | `organization_id`, `max_storage_bytes`, `updated_at` — read model from Kafka | **yes** |

**Exposes:**

| Method | Path | Purpose |
|---|---|---|
| POST | `/resources` | Create; enforces storage limit in one transaction (§19.6) |
| GET | `/resources` | Keyset-paginated, RLS-scoped |
| GET | `/resources/:id` | **The sharpest H1 test target** |
| DELETE | `/resources/:id` | Frees storage |

**Publishes:** `ResourceCreated`, `ResourceDeleted` → `resource.events`;
`CrossTenantAccessAttempted` → `security.events`.

**Consumes:** `SubscriptionChanged` → refresh `plan_limit_cache`.

**Why this boundary is right for the POC.** Keeping business resources in their own database with
their own RLS policies means the H1 proof is a genuinely cross-database, cross-service proof — not
a filter inside the same service that owns users.

---

### 8.7 `audit-service`

**Why it exists.** The brief requires onboarding, plan-limit rejections and cross-tenant access
attempts to leave a **structured trace** usable to *detect* a tenant leak in production. A log that
the audited service can rewrite is not evidence.

**Owns — `audit_db`:**

| Table | Contents |
|---|---|
| `audit_events` | `id`, `event_id` (unique — idempotency), `event_type`, `organization_id` (nullable), `actor_user_id`, `correlation_id`, `severity`, `payload` (jsonb), `occurred_at` |
| `security_events` | Same shape, narrowed to cross-tenant attempts and auth failures |
| `consumed_events` | `event_id`, `consumed_at` — consumer-side dedupe |

Append-only: no `UPDATE` or `DELETE` is granted to the service's database role.

**Exposes:**

| Method | Path | Purpose |
|---|---|---|
| GET | `/audit` | Org Admin: own org's events (RLS-scoped). Platform Admin: metadata-level events only |
| GET | `/audit/security` | Platform Admin: cross-tenant attempts across all orgs |

**Publishes:** nothing. It is a pure sink.

**Consumes:** every topic — `organization.events`, `user.events`, `subscription.events`,
`resource.events`, `security.events`.

**Why this boundary is right for the POC.** A pure consumer that no service can call synchronously
cannot be persuaded to forget an event. And because it is asynchronous, an audit outage degrades
observability without ever failing a user request (§30).

---

## 9. Service Communication

### 9.1 The rule

> **Use REST when the caller cannot continue without the answer.
> Use Kafka when another service merely needs to react.**

Applied strictly, this yields very few asynchronous interactions in the MVP — which is correct.
Replacing a synchronous call with an event does not reduce coupling if the caller still has to wait
for the result; it only makes the waiting invisible.

### 9.2 Communication matrix

| From | To | Mechanism | Reason |
|---|---|---|---|
| Frontend | api-gateway | REST/JSON | Request/response; the user is waiting |
| api-gateway | auth-service | REST | Login must return a token to this caller, now |
| api-gateway | tenant-service | REST + signed context | Caller blocks on the result |
| api-gateway | user-service | REST + signed context | Caller blocks on the result |
| api-gateway | subscription-service | REST + signed context | Caller blocks on the result |
| api-gateway | resource-service | REST + signed context | Caller blocks on the result |
| api-gateway | audit-service | REST + signed context | Audit *reads* are queries |
| api-gateway | Redis | Direct | Rate-limit buckets, token denylist |
| tenant-service | auth-service | REST (internal) | Saga step 2 must know credential creation succeeded before advancing |
| tenant-service | subscription-service | REST (internal) | Saga step 4 must know the default plan was assigned |
| **auth-service** | **user-service** | **REST (internal)** | Login/refresh must embed the caller's CURRENT role in the JWT `roles` claim — role is user-service's data (`users.role`), not auth-service's, and the token must reflect a promotion/demotion immediately, not after an eventual-consistency delay |
| user-service | subscription-service | **Same database transaction** | Seat check must be ACID — §19. Not a network call at all |
| resource-service | subscription-service | Local `plan_limit_cache` + own transaction | Storage limit enforced in one local transaction; cache refreshed by event |
| **any service** | **audit-service** | **Kafka** | Audit must never block, slow, or fail a user request |
| user-service | subscription-service | **Kafka** (`UserCreated`/`UserRemoved`) | Counter *reconciliation* for display — not enforcement |
| resource-service | subscription-service | **Kafka** (`ResourceCreated`/`ResourceDeleted`) | Storage counter reconciliation |
| subscription-service | resource-service | **Kafka** (`SubscriptionChanged`) | Resource service refreshes its limit cache; eventual consistency is fine |
| tenant-service | user-service | **Kafka** (`OrganizationProvisioned`) | First-admin-user creation can complete just after the signup response |

### 9.3 The only genuinely asynchronous interactions

Three, and each is justified:

1. **Audit** — must not be on the critical path. If Kafka is down, requests still succeed (§30.2).
2. **Usage counter reconciliation** — display values that may lag by milliseconds without harm.
   Enforcement never reads them.
3. **Limit cache refresh** — a plan change propagating to `resource-service` within seconds is fine,
   because the authoritative check is `resource-service`'s own transaction against its cache *plus*
   a `CHECK` constraint.

Everything else is REST. Notably, the **seat-limit check is not a network call at all** — §19.

### 9.4 Internal context header

Every service-to-service REST call carries:

```
x-internal-context: base64({ userId, orgId, roles[], correlationId, iat, exp })
x-internal-signature: HMAC-SHA256(payload, INTERNAL_SIGNING_SECRET)
x-correlation-id: <uuid>
```

Receiving services verify the HMAC and the 30-second `exp` before doing anything else. Rejection is
`401`, logged as a security event. Services bind only to the internal Docker network — they are not
published to the host — so this is defence in depth, not the only control.

**Anonymous context, for the three `@Public()` gateway routes (§11.5).** `/auth/login`,
`/auth/refresh` and `/onboarding/signup`/`/invitations/:token/accept` have no authenticated identity
yet — there is nothing for the gateway to sign as `userId`/`orgId`. Rather than let `auth-service`
or `tenant-service` declare their own `@Public()` exception to `InternalContextGuard` (which would
mean two different bypass mechanisms in the system), the gateway signs an **anonymous context** for
these routes: the same header shape, with `userId: null`, `organizationId: null`, `roles: []`. The
signature still proves "this request came through the gateway, over the internal network, within
the last 30 seconds" — it just asserts no identity. `InternalContextGuard` verifies it exactly as it
verifies any other signed context; **no downstream service ever declares a route `@Public()`**. The
receiving handler for these specific routes simply does not read `TenantContext.get()` for identity
(there is none), and validates its own input via DTOs instead.

This keeps the system's isolation-bypass story to exactly one shape everywhere: a request without a
valid, non-expired HMAC signature is rejected, full stop — whether or not that signature happens to
assert an identity.

**Who signs a *service-initiated* internal call.** §9.2's matrix lists several service-to-service
calls (`tenant-service` → `auth-service`, `auth-service` → `user-service`, and more as later
services are built) that are not the gateway forwarding a client request — one service is calling
another directly. Those calls are signed by `libs/tenant-context`'s `InternalHttpClient`, the single
wrapper every internal HTTP client in every service uses instead of raw `HttpService`:

- If the calling service currently has an open `AsyncLocalStorage` tenant-context scope (it is
  itself in the middle of handling a request), `InternalHttpClient` **propagates that context
  forward** — same `userId`/`organizationId`/`roles`, same `correlationId` — so a call chain
  correlates end to end under one trace id (§26.2) and carries the same identity the whole way.
- If no scope is open — a background job, or a call made *before* any identity exists yet (e.g.
  `tenant-service`'s onboarding saga calling `auth-service` to create the credential that will
  become an identity) — `InternalHttpClient` signs an **anonymous context**, the identical mechanism
  described above for the gateway's three `@Public()` routes.

Either way, the receiving service's `InternalContextGuard` verifies the same signature the same way.
A client that calls `HttpService` (or raw `axios`) directly, bypassing `InternalHttpClient`, sends
an unsigned request that every other service's guard correctly rejects with `401` — this was caught
as a real defect during `user-service`'s implementation (§32.3) and fixed by making
`InternalHttpClient` the only way to make one of these calls, not by each call site remembering to
sign.

---

## 10. API Gateway

### 10.1 Decision: yes, use one

A gateway is justified here for a specific reason rather than by convention: **there must be exactly
one place where a client-supplied JWT becomes trusted internal tenant context.** Without it, seven
services each decide independently how to read `orgId` from a token — seven implementations, seven
chances to trust the wrong claim.

### 10.2 Responsibilities

| Responsibility | Detail |
|---|---|
| **Routing** | Path-prefix routing to the seven services; no aggregation except §10.4 |
| **Authentication verification** | Verify JWT signature, expiry, and Redis denylist. The **only** component that trusts a client token |
| **Internal context minting** | Translate verified claims into the signed `x-internal-context` header (§9.4) |
| **Correlation ID** | Accept a client `x-correlation-id` or mint a UUIDv4; propagate to every downstream call and log line |
| **Rate limiting** | `@nestjs/throttler` with Redis storage. Stricter buckets on `/auth/login` and `/onboarding/signup` (the public routes) |
| **Security headers** | `helmet`; CORS allowlist from `CORS_ORIGINS` |
| **Coarse request validation** | Reject malformed JSON, oversized payloads, unknown routes before they cost a downstream hop |
| **Coarse authorisation** | Role-level route guards only — "is this a Platform Admin route?" Fine-grained CASL stays downstream (§12.4) |

### 10.3 What the gateway must never do

- No database, no entity, no TypeORM.
- No business rules. It must not know what a plan limit is or when an invite is valid.
- No fine-grained authorisation — it does not have the subject in hand (§12.4).
- No response body rewriting beyond error-shape normalisation.

**Test for whether logic belongs here:** if it needs a domain concept to make a decision, it does not.

### 10.4 Aggregation — one case only

`GET /api/v1/dashboard` fans out to `subscriptions/current` and `users?limit=5`. Justified because
it saves the SPA a waterfall on the most-visited screen. Any further aggregation requires a
documented reason — otherwise the gateway slowly becomes the monolith the architecture avoids.

### 10.5 Preventing bypass of the gateway

Four layers, so that "clients must go through the gateway" is enforced rather than assumed:

1. **Network.** Only `api-gateway` and `frontend` publish ports in `docker-compose.yml`. The seven
   services join an internal bridge network with no host port mapping — they are not addressable
   from outside.
2. **Signature.** Every service runs `InternalContextGuard`. A request without a valid HMAC over a
   non-expired payload is rejected with `401`, regardless of origin.
3. **No client-token path downstream.** Downstream services have no JWT verification code and no
   access to `JWT_SECRET`. They *cannot* accept a raw client token even if one is sent.
4. **Distinct secrets.** `JWT_SECRET` (gateway + auth-service) and `INTERNAL_SIGNING_SECRET`
   (gateway + all services) are separate. Compromise of one does not forge the other.

The result: a client cannot reach a service directly, and cannot forge `orgId` even if it could —
`orgId` is inside the HMAC-signed payload.

---

## 11. Authentication Architecture

Authentication answers exactly one question: **who is this user?** It does not decide what they may
do (§12) or whose data they may touch (§13).

### 11.1 Owner

`auth-service` owns authentication. It is the only service that sees a password, stores a hash, or
mints a token. `api-gateway` *verifies* tokens but never issues them.

### 11.2 Login flow

```
Browser  POST /api/v1/auth/login { email, password }
   │
   ├─ gateway: helmet → CORS → throttler (strict bucket on this route) → correlation-id
   │           route is @Public() — one of four business routes (§11.5)
   ▼
auth-service
   ├─ ValidationPipe: email format, password presence          ← bad input dies here
   ├─ SELECT credentials WHERE email = $1                       (citext, unique)
   ├─ argon2.verify(hash, password)
   │     on failure → generic "Invalid credentials" (no user-existence oracle)
   │                → publish AuthenticationFailed → security.events
   ├─ reject if organization.status != 'active'                 (blocks half-onboarded orgs)
   ├─ GET user-service /internal/users/:id/role   (§9.2 — role is user-service's data,
   │     synchronous, so a promotion/demotion is reflected on the very next login)
   ├─ mint ACCESS token  (15 min)   { sub, orgId, roles, jti, iat, exp }
   ├─ mint REFRESH token (7 days)   stored hashed in refresh_tokens
   ▼
Response  { accessToken, refreshToken, user: { id, email, role, organizationId } }
```

### 11.3 The identity → tenant mapping

This is the hinge of the whole system:

**Who mints `user_id`.** During onboarding, `auth-service` creates a credential row
*before* any `users` row exists (`user-service` creates it later, asynchronously,
reacting to `OrganizationProvisioned` — §8.4 "consumes"). `auth-service` is
therefore the earliest point this identity exists, and it mints the UUID: it
generates `user_id`, uses it as `credentials.user_id`, and carries it in the
`UserCredentialsCreated` event payload so `user-service` creates its row with that
same id as the primary key — never a fresh one. `POST /internal/auth/credentials`
does not accept a caller-supplied `userId` for exactly this reason: accepting one
would let a caller assert an identity rather than receive the one the system of
record minted.

```
credentials.user_id ──────► users.id            (one user, one organisation)
credentials.organization_id ─► organizations.id  (NULL for Platform Admins)
                    │
                    ▼
            JWT claim  orgId
                    │
                    ▼
       gateway mints x-internal-context.orgId (HMAC-signed)
                    │
                    ▼
       AsyncLocalStorage tenant context in each service
                    │
                    ▼
       SET LOCAL app.current_org = <orgId>
                    │
                    ▼
       PostgreSQL RLS policy filters every row
```

**A user belongs to exactly one organisation** (brief §3.1), so `orgId` is a scalar claim set at
token-mint time. It is never derived from a request body, a query parameter, a path segment or a
client-supplied header — the only place it can come from is a token `auth-service` signed.

**Platform admins have `orgId = null`.** This is not a special case bolted on; it is what makes §13.6
work. A null `app.current_org` makes every RLS policy evaluate false, so a platform admin reads zero
rows from every tenant table by construction.

### 11.4 Token strategy

| Token | Lifetime | Storage | Contents |
|---|---|---|---|
| Access | 15 minutes | Client memory (not `localStorage`) | `sub`, `orgId`, `roles`, `jti`, `iat`, `exp` |
| Refresh | 7 days | httpOnly cookie; hash in `auth_db`, index in Redis | `sub`, `jti` only — **no `orgId`**, so a stolen refresh token cannot assert a tenant |

Rotation: single-use. Each refresh issues a new refresh token and marks the old one `replaced_by`.
Presenting an already-replaced token is treated as theft — the whole token family is revoked and a
security event is published. Logout adds the access token's `jti` to a Redis denylist keyed to its
remaining TTL, which is why revocation is immediate rather than up-to-15-minutes-late.

### 11.5 Passport wiring

- `JwtStrategy` (`passport-jwt`) lives in **`api-gateway` only**.
- `JwtAuthGuard` is registered as a global `APP_GUARD` at the gateway, so routes are authenticated
  by default and `@Public()` is required to opt out. **Four business routes carry `@Public()`:**

  | Route | Why it must be anonymous |
  |---|---|
  | `/onboarding/signup` | The brief's stated exception — an organisation must be able to onboard itself |
  | `/auth/login` | You cannot authenticate to authenticate |
  | `/auth/refresh` | `JwtAuthGuard`/`JwtStrategy` validate an **access** token; refresh exists precisely because the caller's access token has expired, so requiring a valid one to call it would make the flow unusable in the only situation it is ever needed. The refresh token itself — a separate credential, single-use, rotated, theft-detected (below) — is auth-service's own thing to verify, not the gateway's; an attacker with no token at all who calls this route gets exactly what they would at `/auth/login` |
  | `/invitations/:token/accept` | An invitee has no account yet. The **token is the credential** — single-use, hashed at rest, expiring (D-Q7), and it resolves to exactly one invitation in one organisation, so it carries its own tenant scope |

  This list is the auditable form of the brief's "no anonymous path beyond the onboarding/signup
  flow itself" requirement. Accepting an invitation is part of that onboarding flow; a fifth
  `@Public()` route would need an equally explicit justification here. (Two further paths, `/health`
  and `/health/ready`, are exempted on separate grounds — §26.4's hardcoded liveness/readiness
  check, not this decorator — and are excluded from this count.)
  `/auth/logout` is deliberately **not** in this list: it needs the caller's own verified access
  token to extract the `jti` it denylists (§16.2) — accepting an unverified request would let any
  caller revoke any other caller's session by guessing a `jti`.
- Downstream services use `InternalContextGuard` instead — also a global `APP_GUARD`.

### 11.6 Argon2 parameters

Argon2id, `memoryCost` 19456 KiB, `timeCost` 2, `parallelism` 1 (OWASP baseline). Tuned at
implementation to ~250ms on target hardware. A dummy verify runs on unknown emails so that login
timing does not reveal whether an account exists.

---

## 12. Authorization Architecture (CASL)

### 12.1 Three separate questions

The most common way to get this wrong is to conflate these. They stay separate in the code:

| Question | Mechanism | Where | Failure mode |
|---|---|---|---|
| **Who are you?** | JWT + Passport | api-gateway | `401 Unauthorized` |
| **What may you do?** | **CASL** | Inside each service | `403 Forbidden` |
| **Whose data may you touch?** | **PostgreSQL RLS** | Database | `404 Not Found` + security event |

CASL is **not** used for tenant isolation. A CASL condition like `{ organizationId: ctx.orgId }` is
a *convenience* that produces good errors — it is never the thing standing between Org A and Org B.
That is RLS's job (§13). Conflating them would mean a developer who forgets a CASL rule creates a
data leak; keeping them separate means they create at most a permissions bug.

### 12.2 Actions and subjects

```
Action:  'create' | 'read' | 'update' | 'delete' | 'manage'
Subject: 'Organization' | 'User' | 'Subscription' | 'Plan' | 'Resource' | 'AuditEvent' | 'all'
```

### 12.3 Roles → abilities

Described here, implemented later.

**Platform Admin** (`orgId = null`)
```
can    ('read',   'Organization')            // metadata only
can    ('read',   'Subscription')            // aggregate counters only
can    ('read',   'Plan')
can    ('manage', 'Plan')                    // catalogue administration
can    ('read',   'AuditEvent', { severity: 'security' })
cannot ('read',   'Resource')                // ← explicit, R9
cannot ('read',   'User')                    // ← explicit, R9
```
The two `cannot` rules are the codified form of "a platform admin route that happens to expose
content data is a failure of this POC". They are deliberately explicit rather than merely absent,
so that a reviewer can point at them — and RLS enforces the same boundary independently.

**Org Admin**
```
can ('manage', 'User',         { organizationId: ctx.orgId })
can ('manage', 'Resource',     { organizationId: ctx.orgId })
can ('read',   'Organization', { id: ctx.orgId })
can ('read',   'Subscription', { organizationId: ctx.orgId })
can ('update', 'Subscription', { organizationId: ctx.orgId })   // plan change
can ('read',   'AuditEvent',   { organizationId: ctx.orgId })
can ('read',   'Plan')
```

**Org Member**
```
can ('read',   'Resource',     { organizationId: ctx.orgId })
can ('create', 'Resource')
can ('update', 'Resource',     { organizationId: ctx.orgId, createdBy: ctx.userId })
can ('delete', 'Resource',     { organizationId: ctx.orgId, createdBy: ctx.userId })
can ('read',   'User',         { id: ctx.userId })              // self only
can ('read',   'Organization', { id: ctx.orgId })
cannot ('manage', 'User')                                       // cannot invite or remove
```

### 12.4 Where CASL lives — decision

**Decision: primarily inside each service; only coarse role checks at the gateway.**

| Layer | Does | Why |
|---|---|---|
| **api-gateway** | Route-level role check: "is this a Platform-Admin-only route?" | Cheap rejection before a network hop. Uses only the `roles` claim, which it already has |
| **Each service** | Full CASL ability check, including conditions on the actual subject | **The gateway does not have the subject.** To evaluate `can('update', user)` where the rule is `{ organizationId: ctx.orgId }`, you must have loaded that user. Only the owning service can |

**Both — with different jobs.** The gateway is a fast coarse filter; the service is the real
decision. If the gateway's check were removed, nothing would become insecure; if a service's check
were removed, something would.

CASL lives in `libs/authorization`: `Action`/`Subject` enums, `CaslAbilityFactory`,
`@CheckAbility()` decorator, `CaslAbilityGuard`. Each service imports it and registers its own
subject types.

### 12.5 Enforcement pattern

```
InternalContextGuard  →  TenantContextMiddleware (ALS)  →  CaslAbilityGuard  →  handler
```

`CaslAbilityGuard` reads the context from `AsyncLocalStorage` — **never from the request object** —
builds the ability, and checks the declared `@CheckAbility(Action.Update, Subject.User)`. For rules
with subject conditions, the service loads the subject (already RLS-scoped, so a foreign-tenant
subject is simply absent) and calls `ability.can(action, subject('User', loaded))`.

Ordering matters: RLS runs first, so a cross-tenant ID yields *not found* before CASL is ever asked
whether the action was permitted. That is deliberate — a `403` would confirm the resource exists.

---

## 13. Tenant Isolation Architecture

**This is the most important section of this document.**

The requirement: Organisation A's users see only Organisation A's data; Organisation B's users see
only Organisation B's. This must hold for a well-formed request naming another organisation's
resource by ID, **and it must hold when the developer who wrote the query forgot to scope it.**

### 13.1 Design principle

> Tenant isolation must be **structural**: a property of the system that a query cannot bypass,
> rather than a discipline every engineer must remember.

The test of this claim is concrete. Given a deliberately careless repository method:

```ts
// A new developer writes this. No tenant filter anywhere.
async findAllResourcesForReport() {
  return this.dataSource.query('SELECT * FROM resources');
}
```

Under this architecture that query returns **only the current tenant's rows**, because PostgreSQL
applies the row-level security policy to the raw SQL before returning it. The developer's omission
produces no leak. It cannot — the filter is not in the application at all.

### 13.2 Four enforcement layers

Each layer independently catches a mistake the layer above it might miss.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1 — ORIGIN                                                    │
│ orgId enters the system in exactly one place: a JWT claim signed    │
│ by auth-service. Gateway re-signs it into an HMAC'd internal header.│
│ Never read from body, query, path or client header.                 │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 2 — TRANSPORT (AsyncLocalStorage)                             │
│ Request-scoped context, available at every layer including the      │
│ repository, with no parameter threading and no `req` in services.   │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 3 — DATABASE (PostgreSQL RLS)   ◄── THE STRUCTURAL GUARANTEE  │
│ Every tenant table: ENABLE + FORCE ROW LEVEL SECURITY.              │
│ Policy: organization_id = current_setting('app.current_org')::uuid  │
│ Set automatically per transaction. Applies to ORM and raw SQL alike.│
├─────────────────────────────────────────────────────────────────────┤
│ Layer 4 — DETECTION                                                 │
│ A foreign ID yields zero rows → 404 (never 403) + a                 │
│ CrossTenantAccessAttempted security event → audit-service.          │
└─────────────────────────────────────────────────────────────────────┘
```

### 13.3 Layer 1 — where tenant context originates

`orgId` has exactly one source: the `orgId` claim of an access token minted by `auth-service`,
re-signed by the gateway into `x-internal-context`.

**Forbidden sources, enforced by convention and by review:** request body, query string, path
parameter, or any client-supplied header. A path like `GET /organizations/:orgId/users` is
deliberately **not** in the API design — the org is implied by the token, never named by the caller.
Where an ID does appear in a path (`/users/:id`), it is the *resource* ID, and RLS decides whether
that row is visible.

### 13.4 Layer 2 — how context travels

**Within a service:** `AsyncLocalStorage`, in `libs/tenant-context`.

```
InternalContextGuard        verify HMAC, reject 401 if invalid/expired
        ↓
TenantContextMiddleware     als.run({ userId, orgId, roles, correlationId }, next)
        ↓
any layer                   TenantContext.get()   ← no parameter threading
```

Chosen over request-scoped DI providers because it reaches code NestJS does not inject into —
TypeORM subscribers, the data source wrapper, the logger — which is exactly where the tenant filter
must be applied. (The same pattern is used in the SimERP backend reference repo, which validates the
approach in production.)

**Across service boundaries:** context is never inherited implicitly. Each hop re-verifies the HMAC
signature and re-establishes its own ALS scope and its own `SET LOCAL`. A service that receives a
call from another service trusts the signature, not the caller.

**Across Kafka:** every event carries `organizationId` in its envelope and as the **partition key**.
Consumers open their own ALS scope from the event envelope — they never inherit a producer's
context, because consumption happens on a different connection at a different time.

### 13.5 Layer 3 — the structural guarantee

**Migration pattern applied to every tenant-owned table:**

```sql
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE  ROW LEVEL SECURITY;   -- applies to the table owner too

CREATE POLICY tenant_isolation ON resources
  USING      (organization_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org', true)::uuid);
```

`USING` filters reads, updates and deletes. `WITH CHECK` blocks inserting or updating a row *into*
another tenant — so a malicious or buggy write cannot plant data in Org B either.

**Setting the variable.** A `TenantAwareDataSource` wrapper issues, at the start of every
transaction, from the ALS context:

```sql
SELECT set_config('app.current_org', '<orgId>', true);
```

Not `SET LOCAL app.current_org = $1` — PostgreSQL's `SET`/`SET LOCAL` statements do not accept bind
parameters at all (§32.4 records this as a real defect, caught only once a real Postgres-backed
integration test finally exercised this exact code path). `set_config`'s third argument (`true` =
local) gives the identical transaction-scoping guarantee: it cannot leak across pooled connections —
the single most dangerous failure mode of this pattern — while still accepting a normal parameterized
argument, so `organizationId` is never interpolated into SQL text.

**The database role matters.** Services connect as `app_user`, which:

- is **not** a superuser (superusers bypass RLS entirely),
- does **not** own the tables (`FORCE ROW LEVEL SECURITY` covers owners, but not owning them is
  belt and braces),
- has no `BYPASSRLS` attribute.

Migrations run as a separate `app_migrator` role. This split is what makes the guarantee real: no
credential the application holds at runtime is capable of bypassing the policy.

A third role, `app_rls_bypass` (§13.6, §32.4), exists solely to own the small set of narrow SECURITY
DEFINER lookup functions §13.6 documents. It is `NOLOGIN` — no credential connects as it, ever — and
`BYPASSRLS`, which is what makes those specific functions actually bypass RLS (a SECURITY DEFINER
function owned by a NOBYPASSRLS role, like `app_migrator`, does not bypass FORCE ROW LEVEL SECURITY —
confirmed empirically, §32.4). It does not weaken the three bullets above: `app_user` remains exactly
as described, and §13.8's startup check verifies `app_user`, not this role.

**Second mechanism — `TenantRepository`.** A base class wrapping TypeORM that injects
`organization_id` on write and adds the predicate on read. This is *not* the guarantee; RLS is. It
exists because good errors and readable code are worth having, and because two independent
mechanisms must both fail for a leak to occur.

### 13.6 Platform admin — a separate path, not a bypass

R9 requires a platform admin to see organisations but not content, and the boundary must be real.

- Platform admin tokens carry **`orgId = null`**.
- Therefore `app.current_org` is unset. `current_setting('app.current_org', true)` returns NULL,
  the policy predicate evaluates to NULL (not true), and **every tenant table returns zero rows**.
- Platform admins read only from `tenant_db` (org metadata, no content) and from
  `subscription-service`'s aggregate endpoint (integers, no content).

**There is no general-purpose bypass flag.** No `skipRls`, no `asSystem()`, no admin connection pool
— no boolean parameter that an endpoint could accidentally set to read across every tenant. The two
genuine exceptions in the system are both narrow, named, and auditable rather than general:

- **`TenantAwareDataSource.runGlobal()`** (§15.3) — a plain transaction with `app.current_org` left
  unset. Used only where the operation is genuinely tenant-agnostic: migrations, and the
  invitation-expiry sweep's org enumeration (§19.9, which then opens a normal per-org scoped
  transaction for the actual work). It grants no special database privilege — a query run through it
  is subject to RLS exactly like any other `app_user` query, which is precisely why it returns
  nothing useful against a tenant table on its own.
- **`users.get_user_organization_id(uuid)`**, a `SECURITY DEFINER` SQL function (§8.4) — the one
  place a genuine RLS bypass exists, and it is deliberately as narrow as a bypass can be: it returns
  **exactly one column** (`organization_id`, never role/email/name/anything else), and exists to
  answer exactly one question — "which org does this user id belong to?" — for `auth-service`'s
  login/refresh role lookup (§9.2), which has no way to know the answer in advance. `app_user` is
  granted `EXECUTE` on this function and nothing broader; it cannot be used to read any other column,
  and every other read of that user's data still goes through the normal RLS-scoped path afterward.
  <br><br>
  Its *owner* is deliberately **not** `app_migrator` — `app_migrator` is `NOBYPASSRLS`, and FORCE ROW
  LEVEL SECURITY applies its policy to the table owner too, which Postgres extends to a SECURITY
  DEFINER function's effective owner during execution (confirmed empirically; §32.4 records this as a
  real defect this function shipped with). The actual bypass comes from ownership by
  `app_rls_bypass` — a `NOLOGIN`, `BYPASSRLS` role nothing ever connects to directly, whose only
  capability is owning this narrow class of function. `SECURITY DEFINER` alone, on a NOBYPASSRLS
  owner, grants no RLS bypass at all.

Neither exception is a parameter an endpoint could flip. Both are declared once, at the schema
level, doing one specific, reviewable thing — which is the difference between an audited exception
and a bypass flag.

This is how "prove a platform admin cannot see content" is answered: not by auditing every platform
admin endpoint for a missing filter, but by observing that the connection they use is structurally
incapable of returning content rows.

### 13.7 How a new developer could bypass isolation — and what stops them

Honest enumeration. Each has a mitigation.

| # | Bypass | Why it is hard | Mitigation |
|---|---|---|---|
| 1 | Forget `WHERE organization_id` on a new query | **Does not leak.** RLS filters it | The careless-query test (§28.4) asserts this permanently |
| 2 | Write raw SQL via `queryRunner.query()` | **Does not leak.** RLS applies to raw SQL identically | Same test covers a raw-SQL variant |
| 3 | Create a new table and forget to enable RLS | **This one would leak** | CI check (§13.8) fails the build for any table with `organization_id` lacking an enabled+forced policy |
| 4 | Open a connection outside `TenantAwareDataSource` | `app.current_org` unset → policy false → **zero rows**. Fails loudly rather than leaking | Integration test asserting an unwrapped connection reads nothing |
| 5 | Connect as superuser / table owner | **This one would leak** | `app_user` is non-superuser, non-owner, `NOBYPASSRLS`. Compose and migrations create it that way; a startup assertion verifies it |
| 6 | Read `orgId` from a request body or param | Would let a caller name another tenant | Code review + a lint rule banning `orgId` in DTOs; no route in the API design accepts one |
| 7 | Join to a non-RLS table that holds tenant data | Possible if a lookup table is misclassified | §13.8 classification test: every table is explicitly global, registry, or tenant-owned |
| 8 | Kafka consumer processes an event without a tenant scope | Consumers run outside a request | Base consumer class opens ALS from the event envelope before the handler runs; no handler receives a raw payload |

Rows 3 and 5 are the two genuine holes. Both are closed by automated checks rather than by review
discipline, because review discipline is exactly what this architecture exists not to rely on.

### 13.8 Automated verification

Four checks, runnable in CI:

1. **RLS coverage test.** Query `information_schema` for every table with an `organization_id`
   column; assert `pg_class.relrowsecurity` and `relforcerowsecurity` are both true and that a
   policy exists. Fails the build on a new unprotected table.
2. **Role capability assertion.** On service startup, assert `current_user` is not superuser and
   has no `BYPASSRLS`. Refuse to boot otherwise — a misconfigured deployment fails closed.
3. **Careless-query test.** A repository method with no tenant filter, plus a raw-SQL variant.
   Seeded with two orgs' data, asserted to return only the current tenant's rows.
4. **Table classification test.** Every table appears in exactly one of three explicit lists —
   `GLOBAL_TABLES` (`plans`, migrations), `REGISTRY_TABLES`, or `TENANT_TABLES`. A new table in
   none of the three fails the build. `REGISTRY_TABLES` covers tables carrying a tenant reference
   with no cross-tenant *listing* surface — every query is a lookup by a unique key the caller
   already has, never a per-organisation scan RLS alone would need to filter. Two justifications
   currently populate it: `organizations`/`onboarding_sagas` (§8.3 — the tenant registry itself,
   not content; RLS would block platform admins' legitimate org-list read, §13.6) and
   `credentials`/`refresh_tokens` (§8.2 — always looked up by email or userId, never listed
   per-organisation; `auth_db` has no RLS at all). A table lands here only under one of these
   justifications, documented at the migration that creates it — never because scoping it felt
   inconvenient.

### 13.9 Cross-tenant attempt detection

When a lookup by ID returns zero rows, the service cannot locally distinguish "does not exist" from
"belongs to another tenant" — which is precisely the desired information hiding. Both return `404`.

The reconciliation that resolves this happens at the **source**, not at `audit-service`, and this is
a deliberate strengthening over an earlier draft of this section (which described `audit-service`
itself reconciling against its own record of known IDs after the fact). Instead, the service that
took the 404 — `resource-service`'s `getById`, `user-service`'s `getById` — runs a NARROW,
existence-only probe immediately, before publishing anything: a `SECURITY DEFINER` function
(`resource_exists`, `users.user_exists`; §13.6) that answers exactly one question, "does this id
exist at all, in any organisation", and returns a single boolean — never the owning organisation,
never any other column. Only when the id genuinely exists elsewhere is `CrossTenantAccessAttempted`
published at all; a genuinely nonexistent id publishes nothing. By the time `audit-service` receives
the event, it is already a confirmed cross-tenant attempt, not a raw "not found" signal needing
further reconciliation — `audit-service` writes every `CrossTenantAccessAttempted` (and every
`AuthenticationFailed`) event directly into `security_events` at `severity: security`, no
reconciliation step of its own required. This is the production tenant-leak detector the brief asks
for: a query over `security_events` grouped by actor.

The probe itself never changes what the CALLER sees: `getById` returns exactly the same `404` either
way, and the probe is best-effort (wrapped so its own failure can never surface as anything but that
same `404` — §32.4). The response is always `404`, never `403`. A `403` would confirm the resource
exists — an existence oracle that leaks precisely the information isolation is meant to protect.

---

## 14. Database Architecture

### 14.1 Ownership

| Database | Owned by | Isolation | Reason |
|---|---|---|---|
| `auth_db` | auth-service | Own database | Credentials are the highest-value data in the system. A separate database means a compromise elsewhere cannot read password hashes |
| `tenant_db` | tenant-service | Own database | The organisation registry is read by platform admins. Keeping it physically apart from content is what makes R9 structural |
| `core_db` | user-service (schema `users`) + subscription-service (schema `subs`) | **Shared database, separate schemas** | §14.2 — the deliberate trade-off |
| `resource_db` | resource-service | Own database | Content. Highest-volume, most likely to need independent scaling |
| `audit_db` | audit-service | Own database | Append-only with a distinct retention and access profile |

### 14.2 The `core_db` trade-off — stated plainly

`user-service` and `subscription-service` share one physical PostgreSQL database, with one schema
each. This is a deliberate deviation from strict database-per-service, and it is the most
consequential trade-off in this document.

**Why.** R7 requires that two concurrent invites which each individually fit the seat limit cannot
both succeed. The seat limit lives in `subs.subscriptions`; the users being counted live in
`users.users`. To guarantee that invariant with a database transaction, both tables must be
reachable from **one** transaction. With separate databases, the options are:

| Option | Cost |
|---|---|
| Two-phase commit across databases | Operationally heavy; TypeORM has no first-class support |
| Seat-reservation saga (reserve → create → confirm, with compensation) | Real distributed-systems work, but introduces a window where a crash between reserve and confirm leaks a seat, requiring a reconciliation job. More moving parts, and a genuinely at-risk edge case, for an MVP |
| **Shared database, separate schemas** | Loses physical separation between two services. Gains a single ACID transaction with no compensation path and no reconciliation window |

The third is chosen. **A correctness guarantee that is simple and provable is worth more in this POC
than a topology diagram that looks more distributed.** The concurrency requirement is explicitly
graded; database-per-service is not.

**What is preserved despite sharing.** The boundary is still real:

- Each service has its **own TypeORM `DataSource`**, its own entities, its own migration directory.
- Every service in the whole system — not only user-service and subscription-service — connects as
  the **same single database role**, `app_user` (§13.5, §22.1). That role's isolation-relevant
  property is `NOSUPERUSER`/`NOBYPASSRLS` (so RLS cannot be bypassed by any service, §13.8 check #2)
  — it is not that each service gets its own distinct role. The boundary between `user-service` and
  `subscription-service` is enforced by **grant scope, applied per-table, per-migration**, not by
  separate credentials: **user-service's own migration** grants `app_user` `SELECT`/`UPDATE` on
  `subs.subscriptions` **and nothing else** in `subs` — that is the narrow slice user-service's code
  actually calls (§19.4's seat-changing transactions read and adjust `used_seats`, never insert or
  delete a row). `subscription-service` *owns* `subs.subscriptions` — it creates the row during
  onboarding and updates the plan/limit columns on a downgrade — so its own migration additionally
  grants `INSERT` on the same table. Because both services connect as the one shared `app_user`,
  these grants are additive at the role level; the boundary that matters is which repository, in
  which service's code, issues which verb — never a blanket `ALTER DEFAULT PRIVILEGES ... IN SCHEMA
  subs`, which would hand either connection full CRUD on every table the other service ever creates
  there (§32.4 records a defect where exactly that grant shape had to be removed).
- That grant exists for the **seat-enforcement transactions in §19, and only those**. They are
  enumerated in §19.4: invite, accept, revoke, remove, expire, and the downgrade check. Every one
  locks the same subscription row; together they maintain the `used_seats` invariant. Any *other*
  cross-schema query is an architecture violation, caught by the review checklist.
- Neither service reads the other's tables for ordinary queries. Display data still flows by event.

**The split path.** When these must separate — different scaling profiles, different teams,
different compliance zones — seat enforcement moves into `subscription-service`, which already owns
`used_seats`. It gains a small internal API that the six seat-changing paths (§19.4) call instead of
locking the row directly:

```
POST /internal/subscriptions/seats/reserve    → +1 under its own transaction
POST /internal/subscriptions/seats/release    → −1
POST /internal/subscriptions/seats/check      → downgrade validation
```

`user-service` then reserves, writes its row, and confirms or releases — a saga, with the crash
window between reserve and write swept by a reconciliation job. Note this is a **different job**
from the D-Q7 invitation sweep (§19.9): that one expires invitations on a business rule, this one
would reclaim seats abandoned by a crashed request.

The **public** API surface does not change; the internal one does, and the guarantee weakens from
ACID to compensated. That is the real cost of the split, and it is why the shared database is the
right call for the POC. Written down so the next engineer inherits a decision, not a surprise.

### 14.3 Schema sketch

Indicative shapes for orientation. Actual entities are implementation-phase work.

```
auth_db
  credentials         id, user_id, organization_id?, email(citext,uniq), password_hash, status
  refresh_tokens      id, credential_id, token_hash, expires_at, revoked_at, replaced_by

tenant_db
  organizations       id, name, slug(uniq), status, created_at
  onboarding_sagas    id, idempotency_key(uniq), organization_id?, state, admin_email, attempts

core_db / users                                                         [RLS]
  users               id, organization_id, email, first_name, last_name, role, status
                      UNIQUE (organization_id, email)
  invitations         id, organization_id, email, role, token_hash, expires_at, accepted_at
                      -- a pending, unexpired invitation HOLDS A SEAT (D-Q1/D-Q7)
                      UNIQUE (organization_id, email) WHERE accepted_at IS NULL

core_db / subs
  plans               id, code(uniq), name, max_users, max_storage_bytes, is_active   [global]
  subscriptions       id, organization_id(uniq), plan_id, status,                     [RLS]
                      used_seats, used_storage_bytes,
                      max_seats_snapshot, max_storage_snapshot, version
                      CHECK (used_seats          <= max_seats_snapshot)
                      CHECK (used_storage_bytes  <= max_storage_snapshot)
  subscription_history id, organization_id, from_plan_id, to_plan_id, changed_by      [RLS]

resource_db
  resources           id, organization_id, name, description, size_bytes, created_by  [RLS]
  plan_limit_cache    organization_id, max_storage_bytes, updated_at                  [RLS]

audit_db
  audit_events        id, event_id(uniq), event_type, organization_id?, actor_user_id,
                      correlation_id, severity, payload(jsonb), occurred_at
  security_events     (same shape, security severity only)
  consumed_events     event_id(uniq), consumed_at
```

Note `max_seats_snapshot` on `subscriptions`: the plan's limit is denormalised onto the subscription
row so the `CHECK` constraint can reference it. A `CHECK` cannot span tables — and this constraint
is the §19 backstop, so it must be enforceable by the database alone.

### 14.4 Indexing

Every tenant table leads its indexes with `organization_id`, because every query is tenant-scoped —
so the composite index serves both the RLS predicate and the query:

```
users              (organization_id, created_at DESC, id)   -- keyset pagination
                   (organization_id, email) UNIQUE
invitations        (organization_id, accepted_at, expires_at) -- sweep + drift recompute
                   (organization_id, email) UNIQUE WHERE accepted_at IS NULL
                   (token_hash) UNIQUE                        -- acceptance lookup
resources          (organization_id, created_at DESC, id)
subscriptions      (organization_id) UNIQUE
audit_events       (organization_id, occurred_at DESC)
                   (correlation_id)                          -- trace reconstruction
```

### 14.5 Migrations

TypeORM migrations, checked in, **one directory per service**. `synchronize: false` in every
environment without exception — it is the one setting that could silently drop an RLS policy.
Migrations run as `app_migrator`; the runtime role `app_user` has no DDL rights. Every migration
creating a tenant table must, in the same migration, enable and force RLS and create the policy —
enforced by the §13.8 CI check.

---

## 15. TypeORM Strategy

TypeORM is the only ORM. No Prisma, Sequelize, Drizzle or Mongoose, in any service, at any time.

### 15.1 Configuration

| Setting | Value | Reason |
|---|---|---|
| `synchronize` | `false` — always | Would drop RLS policies silently |
| `migrationsRun` | `false` | Migrations are an explicit deploy step, not a boot side effect |
| `namingStrategy` | `SnakeNamingStrategy` | `organizationId` ↔ `organization_id` without per-column mapping |
| `logging` | `['error','warn','migration']`; `query` in dev only | Query logs can contain tenant data |
| `entities` | Explicit imports, not globs | Globs make it possible to load another service's entity by accident |
| `poolSize` | Per service, tuned | Each service has its own pool |

### 15.2 Entity organisation

Entities live in the service that owns them. There is **no shared entity library** — a shared entity
is shared coupling, and it invites the cross-service table access §21 forbids. `libs/common` holds
shared *types, DTOs and event contracts* only, never `@Entity()` classes.

`TenantBaseEntity` in `libs/database` carries `id`, `organizationId`, `createdAt`, `updatedAt`,
`deletedAt`. Every tenant-owned entity extends it, so `organization_id` cannot be forgotten on a
new table — the same column the RLS policy and the CI check both look for.

### 15.3 `TenantAwareDataSource`

The single point through which tenant scoping is applied:

- Wraps `DataSource.transaction()`; issues `SELECT set_config('app.current_org', $1, true)` from the
  ALS context before running the callback (not `SET LOCAL app.current_org = $1` — see §32.4;
  Postgres's `SET`/`SET LOCAL` reject bind parameters entirely, `set_config`'s third argument gives
  the identical transaction-local scoping).
- Refuses to open a transaction when tenant context is absent **and** the caller has not explicitly
  declared a global operation (`runGlobal()`, used only by migrations, the plan catalogue, and
  Kafka consumers before they establish their own scope).
- Applies to `QueryRunner` access, so raw SQL is covered identically.

Read-only queries outside an explicit transaction are wrapped in an implicit one, because this
scoping call requires a transaction to apply "local" to. The small cost of an extra `BEGIN`/`COMMIT`
on simple reads buys the guarantee that there is no code path where the variable is unset.

**A fourth method, `transactionWithDeferredScope()`, for the one case where the organisation is not
known until partway through a transaction.** Invitation acceptance (§19.8) is the case: the caller
has only a token, and the organisation it belongs to is discovered by looking the token up — but the
lookup, the discovery, and the subsequent scoped work (locking the subscription row, creating the
user, marking the invitation accepted) all need to happen under **one** lock, with no gap where a
concurrent request could act between "found the org" and "scoped the transaction to it". This method
opens a transaction with `app.current_org` unset (like `runGlobal()`), hands the callback a
`setScope(organizationId)` function, and lets the callback call it once it has discovered which
tenant it belongs to — every query after that point in the *same* transaction is scoped exactly as
`transaction()` would have scoped it from the start. The initial, pre-scope lookup must be on a
non-RLS-dependent key (a random single-use token is itself the authorization to read that one row —
§11.5) or via one of the two named exceptions in §13.6.

### 15.4 Repository pattern and DI

Services depend on **interfaces**, not on `Repository<T>`:

```
IUserRepository            (libs or service domain layer — an interface)
   ▲
   │ implements
TypeOrmUserRepository      (infrastructure; extends TenantRepository)
```

Bound by injection token in the service's module. This is what lets unit tests substitute an
in-memory repository with no database, and what makes a future storage change a module edit rather
than a service rewrite (§20).

### 15.5 Transactions

Explicit `dataSource.transaction(async (manager) => …)` in the application service layer. Never a
decorator that hides the boundary, because §19's correctness depends on knowing exactly where the
transaction begins and ends.

**Rule: no network call inside a transaction.** No HTTP, no Kafka publish, no Redis round-trip. A
transaction holding a row lock while awaiting a network response is how a seat-limit check becomes
a site-wide stall. Events are published *after* commit (§17.5).

---

## 16. Redis Strategy

### 16.1 Decision

Redis is included for **three narrowly-scoped jobs**. It is never the source of truth for business
data, and explicitly never the mechanism guaranteeing the plan-limit constraint.

### 16.2 What Redis does

| # | Use | Key shape | TTL | Why Redis |
|---|---|---|---|---|
| 1 | **Rate limiting** | `throttle:{ip|userId}:{route}` | Window | `@nestjs/throttler`'s in-memory store is per-process. With multiple gateway replicas, in-memory limits are per-replica — meaning the real limit is N× the configured one. Shared state is required for the limit to mean anything |
| 2 | **Token denylist + refresh index** | `denylist:{jti}`, `refresh:{jti}` | Token remaining TTL | Makes logout immediate rather than up-to-15-minutes-late. Naturally expiring keys are exactly the right primitive — no cleanup job |
| 3 | **Onboarding idempotency** | `onboarding:{idempotencyKey}` | 24h | A double-submitted signup must not create two organisations. A short-lived atomic `SET NX` is the cheapest correct answer |

A fourth, optional use: a cached usage read-model (`usage:{orgId}` → seats/storage) for the
dashboard, TTL 30s, refreshed by the Kafka consumer. **Display only.** If this cache is stale, wrong,
or entirely absent, no limit is enforced incorrectly — because enforcement never reads it (§19).

**It must cache `used_seats`, the authoritative counter — not a user count.** Under D-Q1 a seat is
held by a user *or* a pending invitation. A meter showing "3 of 5" while the API returns 409 is
exactly the confusing refusal R6 exists to prevent, so the cached figure and the enforced figure
must be the same number.

### 16.3 What Redis must never do

| Forbidden | Why |
|---|---|
| Guarantee the plan-limit constraint | A distributed lock in Redis cannot be made correct under network partition without fencing tokens. PostgreSQL's row lock is already transactional, already correct, and already present |
| Store business data as source of truth | Redis is configured without AOF persistence here; a restart loses everything, and that must be survivable |
| Cache tenant-scoped content without the tenant in the key | A key collision across tenants is a data leak. Any tenant-scoped key **must** include `orgId` — enforced by a `tenantKey()` helper in `libs/redis` |
| Hold session state | Sessions are stateless JWTs; adding server-side sessions would undo that |

### 16.4 Failure behaviour

Redis down:

- Rate limiting: fails **open** (requests proceed). A rate limiter is a protection, not a correctness
  control, and failing closed would turn a Redis blip into a total outage. Logged as a security-relevant
  degradation.
- Token denylist: fails **closed** for logout — a logged-out token stays valid until it expires
  (max 15 min). Documented as accepted risk.
- Idempotency: falls back to the unique constraint on `onboarding_sagas.idempotency_key`. The
  database is the real guarantee; Redis is the fast path.

Every Redis dependency degrades rather than fails. Nothing in the correctness-critical path touches it.

---

## 17. Kafka / Event-Driven Architecture

### 17.1 Decision

Kafka (KRaft mode — no ZooKeeper container) is the asynchronous event backbone, used **only** where
asynchrony is genuinely appropriate: audit, counter reconciliation and cache invalidation.

### 17.2 Topics

| Topic | Partitions | Key | Producers | Consumers |
|---|---|---|---|---|
| `organization.events` | 3 | `organizationId` | tenant-service | audit, user, subscription |
| `user.events` | 3 | `organizationId` | user-service, auth-service | audit, subscription |
| `subscription.events` | 3 | `organizationId` | subscription-service, user-service | audit, resource |
| `resource.events` | 3 | `organizationId` | resource-service | audit, subscription |
| `security.events` | 3 | `organizationId` (or `'platform'`) | all services | audit |
| `*.dlq` | 1 each | original key | retry handler | manual / operator |

**Keying by `organizationId`** is deliberate: all of a tenant's events land on one partition and are
therefore consumed in order. `UserCreated` before `UserRemoved` for the same org is guaranteed, so
counter reconciliation converges. Ordering across tenants is not required.

### 17.3 Event catalogue

| Event | Producer | Topic | Consumers | Why async | Sync needed? |
|---|---|---|---|---|---|
| `OrganizationCreated` | tenant | organization | audit | Audit only | No |
| `OrganizationProvisioned` | tenant | organization | user, subscription, audit | Signup responds as soon as the org is usable | No |
| `OnboardingFailed` | tenant | organization | audit | Failure record; retry is driven by the saga | No |
| `UserCredentialsCreated` | auth | user | audit | Audit only | No |
| `UserInvited` | user | user | subscription, audit, (email stub) | **A seat is taken at invite (D-Q1)** — but the counter is already updated transactionally; the consumer only detects drift | No |
| `InvitationAccepted` | user | user | subscription, audit | Net-zero seat change; drift detection and audit | No |
| `InvitationRevoked` | user | user | subscription, audit | Releases a seat; counter already updated transactionally | No |
| `InvitationExpired` | user | user | subscription, audit | Released by the sweep (§19.9); drift detection and audit | No |
| `UserCreated` | user | user | subscription, audit | Counter reconciliation for **display** | **No — enforcement is the §19 transaction** |
| `UserRemoved` | user | user | subscription, audit | Frees a seat in the display counter | No |
| `UserRoleChanged` | user | user | audit | Audit only | No |
| `SubscriptionAssigned` | subscription | subscription | tenant, audit | Advances the saga | No |
| `SubscriptionChanged` | subscription | subscription | resource, audit | Resource service refreshes its limit cache | No |
| `PlanLimitExceeded` | user, resource | subscription | audit | **The rejection itself is synchronous (409).** The event is the structured trace | No |
| `ResourceCreated`/`Deleted` | resource | resource | subscription, audit | Storage counter reconciliation | No |
| `CrossTenantAccessAttempted` | any | security | audit | **The 404 is synchronous.** The event is the detection trace | No |
| `AuthenticationFailed` | auth | security | audit | Brute-force detection | No |

**Every row answers "no" to "does this need a synchronous response?"** That is the test for whether
an interaction belongs on Kafka. Anything answering "yes" is REST (§9).

### 17.4 What Kafka is deliberately not used for

| Not used for | Instead | Why |
|---|---|---|
| Seat-limit enforcement | PostgreSQL transaction + row lock (§19) | Kafka provides no transactional guarantee across a counter and an insert. Using it here would make the limit eventually-consistent, which is the bug |
| Request/response | REST | A request/response over a message bus is RPC with worse ergonomics and worse failure modes |
| Onboarding saga steps | REST (synchronous) | Each step must know the previous succeeded before advancing (§11.3) |
| Reading another service's data | REST or a read model | Kafka is for notification of change, not for queries |

### 17.5 Publish semantics — transactional outbox (lite)

Events are published **after commit**, never inside a transaction:

```
dataSource.transaction(async (manager) => {
  … business writes …
  collect events in memory
});                                   ← COMMIT here
publishCollectedEvents();             ← then publish
```

The cost is a crash window between commit and publish, where an event is lost. Accepted for the POC,
with a stated upgrade path: a real `outbox` table written in the same transaction and drained by a
poller, which is the standard fix when at-least-once delivery becomes a requirement. Documented
rather than silently assumed.

### 17.6 Consume semantics

- **At-least-once** delivery; consumers must be **idempotent**.
- Idempotency via `consumed_events(event_id)` with a unique constraint — a duplicate insert is
  caught and the event is skipped.
- Manual offset commit **after** successful processing, so a crash mid-handler replays rather than
  skips.
- Retry: 3 attempts with exponential backoff (1s, 5s, 25s), then the DLQ.
- Consumers establish their own tenant ALS scope from the event envelope before the handler runs
  (§13.4) — a handler never sees an unscoped payload.

### 17.7 Event envelope

```
{ eventId, eventType, eventVersion, organizationId, correlationId,
  causationId, actorUserId, occurredAt, payload }
```

`correlationId` is propagated from the originating HTTP request through the Kafka header, so a
single trace spans gateway → service → consumer → audit record (§24).

---

## 18. Kafka vs Redis — Decision

### 18.1 They are not alternatives

A common framing error: Kafka and Redis are not competing choices. They solve unrelated problems and
the comparison is only useful for showing which problems each one is *not* for.

| Dimension | Redis | Kafka |
|---|---|---|
| Model | In-memory key-value store | Distributed, durable, ordered log |
| Durability here | None (no AOF) — restart loses all | Disk-backed with retention |
| Read semantics | Destructive/point read; one consumer takes it | Non-destructive; many consumer groups, independent offsets |
| Replay | No | Yes — from any offset |
| Ordering | No guarantee | Guaranteed within a partition |
| Latency | Sub-millisecond | Single-digit ms |
| Good at | Ephemeral state, counters, TTL keys, rate limits | Event history, fan-out, decoupling, audit trails |
| Wrong for | Durable event history, audit, replay | Rate-limit buckets, TTL keys, hot cache reads |

### 18.2 Options considered

| Option | Assessment |
|---|---|
| **A — Kafka only** | Rate limiting falls back to in-memory, so limits are per-replica and meaningless with more than one gateway. No token revocation. Kafka cannot do TTL keys. **Rejected** |
| **B — Redis only** | Redis Streams could carry audit events, but with no meaningful retention (persistence off), and audit would live in a store the brief needs to be durable. **Rejected** |
| **C — Kafka + Redis** | Each does what it is good at. Two containers, both with narrow, stated jobs. **Chosen** |

### 18.3 Decision — Option C, with responsibilities fixed

```
Redis                                  Kafka
─────                                  ─────
rate-limit buckets                     organization.events
token denylist / refresh index         user.events
onboarding idempotency keys            subscription.events
usage read-model cache (display only)  resource.events
                                       security.events
Never: durable events, audit,          Never: rate limits, caches,
       business truth, limit checks           request/response, limit checks
```

**Neither is the source of truth for anything.** PostgreSQL is, in every case, for every guarantee
that matters. Redis holds things that may vanish; Kafka holds a record of things that already
happened. The one guarantee the brief grades hardest — the plan limit under concurrency — touches
neither (§19).

### 18.4 Honest note on MVP scope

This POC could function with neither. It is a defensible position, and worth stating rather than
pretending otherwise. Each earns its container for a specific reason:

- **Redis** — because rate limiting across more than one gateway replica is otherwise incorrect, and
  because immediate logout otherwise is not possible with stateless JWTs.
- **Kafka** — because the brief requires structured, durable traces for onboarding, limit rejections
  and cross-tenant attempts, and requires that audit never be on the request path. A durable log
  consumed by an isolated, append-only service is the honest shape of that requirement.

If either were dropped, this document would name exactly what is lost. That is the standard applied
to every component here.

---

## 19. Concurrency Strategy

Requirement R7: *two simultaneous requests that would each individually fit within the remaining
limit, but together exceed it, must not both succeed.*

### 19.1 Principles

1. **PostgreSQL is the sole arbiter.** Not Redis, not Kafka, not application-level coordination.
2. **One transaction** spans the check and the write. A check outside the write's transaction is a
   TOCTOU bug wearing a check's clothing.
3. **Pessimistic locking**, not optimistic. Under a burst of 50 invites (the brief's stretch test),
   optimistic retry storms; a row lock serialises cleanly.
4. **A database constraint as backstop**, so the invariant survives a future code path that skips
   the lock.

### 19.2 The flow

```
POST /api/v1/users/invite        org has 4 users · plan limit 5 · two requests arrive together

 gateway   JWT verified → x-internal-context { orgId } signed
    │
 user-service
    │  InternalContextGuard   → HMAC verified
    │  TenantContextMiddleware→ ALS { orgId }
    │  ValidationPipe         → email format, role enum    ← bad input dies HERE
    │  CaslAbilityGuard       → Org Admin may create User
    ▼
 ┌──────────────── SINGLE TRANSACTION (core_db) ─────────────────┐
 │                                                               │
 │  SET LOCAL app.current_org = '<orgId>'      ← RLS armed       │
 │                                                               │
 │  SELECT used_seats, max_seats_snapshot                        │
 │    FROM subs.subscriptions                                    │
 │   WHERE organization_id = $1                                  │
 │     FOR UPDATE                   ◄── REQUEST B BLOCKS HERE    │
 │                                                               │
 │  -- used_seats IS the authoritative seat count (§19.4).       │
 │  -- A seat is held by an active user OR a pending,            │
 │  -- unexpired invitation (D-Q1). No live count() is read.     │
 │                                                               │
 │  IF used_seats >= max_seats_snapshot:                         │
 │      throw PlanLimitExceededException    → 409, ROLLBACK      │
 │                                                               │
 │  INSERT INTO users.invitations (...)    -- the seat is taken  │
 │  UPDATE subs.subscriptions SET used_seats = used_seats + 1    │
 │         WHERE organization_id = $1                            │
 │         ── CHECK (used_seats <= max_seats_snapshot) ── backstop│
 │                                                               │
 └──────────────────── COMMIT ── lock released ──────────────────┘
    │
    └─► after commit: publish UserInvited, UserCreated  (never inside the txn)
```

**What is counted (D-Q1).** A seat is held by an active user **or** a pending, unexpired
invitation. Both the invite path and direct user creation take the same lock on the same
subscription row, so they serialise against each other. The invitation-expiry sweep (D-Q7) takes
that same lock when it releases a seat.

### 19.3 Why request B cannot also succeed

```
 t0   A: BEGIN                              B: BEGIN
 t1   A: SELECT … FOR UPDATE  → acquires    B: SELECT … FOR UPDATE → BLOCKS
 t2   A: used_seats = 4 < 5 → proceed       B: (still blocked)
 t3   A: INSERT invitation (holds seat #5)  B: (still blocked)
 t4   A: used_seats 4 → 5                   B: (still blocked)
 t5   A: COMMIT → lock released             B: acquires lock, re-reads
 t6                                         B: sees used_seats = 5   (fresh read)
 t7                                         B: 5 >= 5 → 409, ROLLBACK
```

The key property: `FOR UPDATE` makes B **wait**, and B re-reads *after* A commits. B never acts on
the stale value it would have seen at t1. This is the entire guarantee, and it is a database
feature, not application logic.

### 19.4 `used_seats` is the authoritative counter — and the invariant that keeps it honest

**The limit is defined on one quantity, not two.** `subscriptions.used_seats` *is* the seat count.
The enforcement check reads it under the row lock; it is never recomputed with a live `count(*)` on
the hot path. This matters because D-Q1 made a seat holdable by two different row types — if the
check read a live count while the `CHECK` constrained a stored column, the constraint would be
guarding a quantity the limit is not defined on, and a path that inserted an invitation without
incrementing the counter would breach the real limit with the constraint still satisfied.

**The invariant:**

```
used_seats == (active users) + (pending, unexpired invitations)
```

**Every path that changes that sum takes the subscription row lock and adjusts `used_seats` in the
same transaction.** There are five, and they are exhaustive:

| Path | `used_seats` | Owner |
|---|---|---|
| Invite a user | **+1** | user-service (§19.2) |
| Accept an invitation | **0** — invitation row becomes a user row | user-service (§19.8) |
| Revoke a pending invitation | **−1** | user-service |
| Remove a user | **−1** | user-service |
| Invitation expires (sweep) | **−1** | user-service (§19.9) |

A sixth path that changes the sum without taking the lock is a bug, even if it appears to work.

**The constraint backstop.** `CHECK (used_seats <= max_seats_snapshot)` means that even if a future
code path increments the counter without taking the lock, PostgreSQL rejects the write. The lock
gives correct behaviour; the constraint gives a guaranteed ceiling. Both must fail for the limit to
be breached. This is why `max_seats_snapshot` is denormalised onto the subscription row (§14.3) —
a `CHECK` cannot reference another table.

**Drift detection.** Because the counter is authoritative, a bug that desynchronises it would be
silent. A periodic reconciliation job recomputes the sum and logs a `security`-severity discrepancy
rather than correcting it silently — a counter that disagrees with its rows is evidence of a code
path that skipped the lock, and that is worth an alert, not a quiet repair.

### 19.5 Rejection behaviour

R6 demands a clear, specific message — not a generic error, not a silent partial success:

```
HTTP/1.1 409 Conflict
{
  "statusCode": 409,
  "error": "PLAN_LIMIT_EXCEEDED",
  "message": "Your Free plan allows 5 seats. All 5 are held (4 users, 1 pending invitation). Upgrade to Pro, remove a user, or revoke a pending invitation.",
  "details": { "limitType": "seats", "limit": 5, "current": 5,
               "activeUsers": 4, "pendingInvitations": 1, "planCode": "free" },
  "correlationId": "..."
}
```

Rollback is automatic — the exception propagates out of `dataSource.transaction()`, so nothing is
written. There is no partial state: no user row, no incremented counter. After rollback, a
`PlanLimitExceeded` event is published for the structured trace the brief requires.

### 19.6 Storage limits — the same shape

`resource-service` enforces `max_storage_bytes` identically: lock its `plan_limit_cache` row for the
org, sum `size_bytes`, compare, insert, update. One transaction, one lock, one `CHECK`. The pattern
generalises to any future counted resource, which is why it is worth stating as a pattern rather
than as a one-off.

### 19.7 Race conditions considered

| Race | Handling |
|---|---|
| Two invites, one seat | The core case. Serialised by `FOR UPDATE` |
| 50 concurrent invites, 2 seats free | All serialise on the same row; exactly 2 succeed, 48 get 409. Tested (§28.4) |
| Invite while plan is being downgraded | Both take the same row lock; whichever commits first wins, the second re-reads the new limit |
| Invite + user removal simultaneously | Both lock the subscription row; ordering is arbitrary but the invariant holds either way |
| Duplicate email in same org | `UNIQUE (organization_id, email)` — caught by the database, returned as 409 |
| Duplicate **pending invite** to the same email | Partial unique index on `(organization_id, email) WHERE accepted_at IS NULL` — a second invite cannot hold a second seat for one person |
| Invite accepted while a sweep expires it | Both take the subscription row lock; acceptance re-checks `expires_at` inside the transaction |
| Plan downgrade below current usage | Blocked (D-Q4): usage is compared against the target plan inside the same locked transaction |
| Lock contention under sustained load | All invites for **one org** serialise; different orgs never contend, because the lock is per-org-row. Acceptable: a single organisation inviting hundreds of users per second is not a real workload |
| Deadlock | Avoided by consistent lock ordering — the subscription row is always locked first, before any user or resource row — with **one documented exception**: invitation acceptance (§19.8) cannot know which subscription row to lock until it has found and locked the invitation row by token, so that one path locks invitation-then-subscription while the sweep (§19.9) locks subscription-then-invitation. PostgreSQL detects the resulting deadlock and aborts one side with `40P01` rather than hanging; the caller retries. Accepted as a rare, detected-not-silent failure mode, not a gap in the guarantee itself — R7's correctness never depends on avoiding this deadlock, only on the lock existing at all |
| Transaction timeout | `statement_timeout` 5s. A blocked request fails with 503 rather than hanging |

### 19.8 Invitation acceptance — net-zero, but still locked

Acceptance converts a held seat from an invitation row into a user row. The sum does not change, so
`used_seats` does not change — but the transaction **still takes the subscription row lock**, because
it must re-check expiry atomically against the sweep (§19.9):

```
BEGIN
  SELECT … FROM subs.subscriptions WHERE organization_id = $1 FOR UPDATE
  SELECT * FROM users.invitations
    WHERE token_hash = $2 AND accepted_at IS NULL AND expires_at > now()
    FOR UPDATE
  → not found: 410 Gone ("This invitation has expired or already been used")
  INSERT INTO users.users (...)
  UPDATE users.invitations SET accepted_at = now()
  -- used_seats UNCHANGED: the seat was already held
COMMIT
```

Without the lock, a sweep could expire the invitation (releasing the seat) between the expiry check
and the user insert, leaving a user occupying a seat the counter no longer counts.

### 19.9 The invitation-expiry sweep (D-Q7)

**Owner: `user-service`.** A scheduled job (`@nestjs/schedule`), the **only** background job in the
system. Per organisation, in its own transaction:

```
BEGIN
  SET LOCAL app.current_org = <orgId>
  SELECT … FROM subs.subscriptions WHERE organization_id = $1 FOR UPDATE
  UPDATE users.invitations SET status = 'expired'
    WHERE organization_id = $1 AND accepted_at IS NULL AND expires_at <= now()
    RETURNING id
  UPDATE subs.subscriptions SET used_seats = used_seats - <count>
COMMIT
→ publish InvitationExpired per released seat
```

Three properties worth noting:

- It takes the **same lock** as the invite path, so a sweep and an invite cannot race.
- It iterates **org by org, establishing tenant scope per organisation** (§15.3 `runGlobal()` to
  enumerate, then a normal scoped transaction per org). It is **not** granted an RLS bypass — that
  would punch a hole in §13.6's "no bypass exists anywhere" guarantee for the sake of a cron job.
  Enumeration reads `DISTINCT organization_id` from `subs.subscriptions` — a table already in
  `core_db`, which `user-service` connects to anyway (§14.2) — rather than calling `tenant-service`
  over HTTP for the org list. Every organisation gets exactly one subscription row during onboarding
  (§30.1), so this is a complete enumeration with no cross-service network dependency added to a
  background job.
- It is **conservative under failure**: if the sweep stalls, seats stay held. An org may see a 409
  while genuinely under its cap, which is a degraded experience but never a breached limit (§30.2).

### 19.10 Plan downgrade — the same pattern, in reverse (D-Q4)

A downgrade mutates `max_seats_snapshot`, the right-hand side of the `CHECK` constraint. It is a
limit check like any other:

```
BEGIN
  SELECT used_seats FROM subs.subscriptions WHERE organization_id = $1 FOR UPDATE
  SELECT max_users, max_storage_bytes FROM subs.plans WHERE id = $target
  IF used_seats > target.max_users
     OR used_storage_bytes > target.max_storage_bytes:
       throw PlanLimitExceededException  → 409, ROLLBACK
  UPDATE subs.subscriptions
     SET plan_id = $target,
         max_seats_snapshot   = target.max_users,
         max_storage_snapshot = target.max_storage_bytes
COMMIT
```

The snapshot columns and `used_seats` are updated in the **same** transaction, so the `CHECK`
constraint is never transiently violated. The 409 is specific:

> *"Your organisation holds 8 seats. The Free plan allows 5. Remove 3 users or revoke pending
> invitations before downgrading."*

Naming pending invitations matters here — an admin looking at 5 users on screen needs to know the
other 3 seats are held by outstanding invites.

### 19.11 Rejected alternatives

| Alternative | Why not |
|---|---|
| Redis distributed lock (Redlock) | Cannot be made correct under partition without fencing tokens; adds a dependency to a path PostgreSQL already handles correctly and transactionally |
| Optimistic locking with retry | Retry storms under the 50-request burst test; worse behaviour in exactly the scenario being graded |
| Kafka-serialised invites | Makes a synchronous operation asynchronous; the caller needs a yes/no now, and the limit would become eventually consistent |
| Application-level mutex | Single-process only; breaks the moment `user-service` has two replicas |
| `SERIALIZABLE` isolation | Would work, but converts contention into serialisation failures the application must retry. `FOR UPDATE` under `READ COMMITTED` is more targeted and more predictable |

---

## 20. Dependency Injection Strategy

DI is mandatory. `new SomeService()` never appears in application code — NestJS's container owns
every lifetime.

### 20.1 Layering

```
Controller            HTTP concerns only: route, DTO in, DTO out. No business rules.
    ↓  injects
Application Service   Orchestration: transaction boundaries, use-case flow, event collection.
    ↓  injects
Domain Logic          Pure business rules. No framework imports, no I/O. Unit-testable alone.
    ↓  injects (INTERFACE, not class)
Repository Interface  IUserRepository — declared by the domain, owned by the domain.
    ▲  implements
TypeORM Repository    Infrastructure. Extends TenantRepository.
    ↓
TypeORM DataSource    TenantAwareDataSource — applies SET LOCAL.
    ↓
PostgreSQL            RLS policies.
```

The dependency *direction* is the point: the domain declares what it needs (`IUserRepository`) and
infrastructure implements it. The domain never imports TypeORM.

### 20.2 Interface binding

```ts
// domain layer — an interface plus a token
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');
export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  countByOrganization(): Promise<number>;
  save(user: User): Promise<User>;
}

// module — binds the implementation
providers: [
  { provide: USER_REPOSITORY, useClass: TypeOrmUserRepository },
]
```

Abstractions are used where they earn their place: repositories, the event publisher, the cache, the
clock. **Not** for everything — a `MapperService` behind an interface is ceremony, not architecture.
The test is whether an alternative implementation is plausible (a real one for tests always is).

### 20.3 What DI buys

**Testing.** A unit test binds an in-memory `IUserRepository` and runs the domain logic with no
database, no container, no Docker. Integration tests bind the real one against Testcontainers. The
same service code runs in both.

**Future service extraction.** When `subscription-service` needs its own database (§14.2), the seat
check moves behind an `ISeatReservationService` interface. The `user-service` application service —
which orchestrates the use case — does not change. The module binds a different implementation. This
is precisely why the seat check is expressed as an injected dependency today, even though it is
currently a local transaction: the seam is already in the right place.

**Cross-cutting concerns.** Guards, interceptors and filters are injectable, so the tenant context,
CASL ability and correlation ID reach them without being threaded through signatures.

### 20.4 Scopes

Default **singleton** for everything. Tenant context comes from `AsyncLocalStorage` (§13.4), not from
request-scoped providers — deliberately, because request-scoped DI would rebuild the dependency tree
per request and, more importantly, would not reach TypeORM subscribers and the data source wrapper,
which is exactly where scoping must be applied.

---

## 21. Repository Structure

### 21.1 Top level

```
React-to-full-stack/
├── backend/                    pnpm workspace — NestJS monorepo
├── frontend/                   pnpm — React + Vite SPA
├── docs/architecture/          this document + the POC brief
├── docker/                     init scripts, service Dockerfiles
├── docker-compose.yml
├── .env.example
└── README.md
```

### 21.2 Backend

```
backend/
├── apps/
│   ├── api-gateway/            routing, JWT verify, context minting, throttling
│   ├── auth-service/           credentials, tokens, Argon2
│   ├── tenant-service/         organisations, onboarding saga
│   ├── user-service/           users, roles, invitations, SEAT LIMIT TRANSACTION
│   ├── subscription-service/   plans, subscriptions, limits, usage
│   ├── resource-service/       tenant resources, storage limit
│   └── audit-service/          Kafka consumer → append-only audit log
│
├── libs/
│   ├── common/                 DTOs, event contracts, shared types, exception filters
│   │                           NEVER @Entity() classes — §15.2
│   ├── auth/                   JwtStrategy, guards, token utilities
│   ├── authorization/          CASL: Action/Subject, ability factory, @CheckAbility, guard
│   ├── tenant-context/         AsyncLocalStorage store, middleware, InternalContextGuard
│   ├── database/               TenantAwareDataSource, TenantBaseEntity, TenantRepository
│   ├── kafka/                  producer, base consumer (opens ALS), envelope, DLQ, retry
│   ├── redis/                  client, tenantKey() helper, throttler storage
│   └── logging/                pino config, correlation-id middleware, redaction
│
├── test/
│   ├── integration/            Testcontainers: RLS, locks, cross-tenant
│   └── e2e/                    full-stack flows through the gateway
│
├── pnpm-workspace.yaml
├── nest-cli.json               monorepo project definitions
└── package.json
```

Each app follows the same internal shape, which keeps the seven services legible as one system:

```
apps/user-service/src/
├── main.ts
├── app.module.ts
├── users/
│   ├── users.controller.ts        HTTP only
│   ├── users.service.ts           orchestration, transaction boundary
│   ├── domain/                    pure rules + repository INTERFACES
│   ├── infrastructure/            TypeORM repository implementations
│   ├── entities/                  owned entities (extend TenantBaseEntity)
│   └── dto/                       class-validator DTOs
├── database/migrations/
└── events/                        producers + consumers
```

### 21.3 Boundary rules

| Rule | Reason |
|---|---|
| An app never imports from another app | That is a distributed monolith |
| `libs/` never imports from `apps/` | Dependencies point one way |
| No `@Entity()` in `libs/` | Shared entities re-create shared tables (§15.2) |
| No cross-service database access | Except the one documented `subs.subscriptions` grant (§14.2) |
| Every app has its own `Dockerfile` and migrations | Independently deployable |

---

## 22. Environment Configuration

`docker compose up` must work with **no manual setup beyond a documented `.env`**. `.env.example` is
checked in, complete, and sufficient to boot.

### 22.1 Variables

```
# ─ Shared ────────────────────────────────────────────────
NODE_ENV=development
LOG_LEVEL=debug

# ─ PostgreSQL ────────────────────────────────────────────
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_SUPERUSER=postgres
POSTGRES_SUPERUSER_PASSWORD=change-me-locally
APP_DB_USER=app_user            # non-superuser, NOBYPASSRLS — §13.5
APP_DB_PASSWORD=change-me-locally
MIGRATOR_DB_USER=app_migrator   # DDL only
MIGRATOR_DB_PASSWORD=change-me-locally
# databases: auth_db · tenant_db · core_db · resource_db · audit_db

# ─ Redis ─────────────────────────────────────────────────
REDIS_HOST=redis
REDIS_PORT=6379

# ─ Kafka ─────────────────────────────────────────────────
KAFKA_BROKERS=kafka:9092
KAFKA_CLIENT_ID_PREFIX=mtsm

# ─ Secrets — MUST be distinct (§10.5) ────────────────────
JWT_SECRET=dev-only-replace-me
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
INTERNAL_SIGNING_SECRET=dev-only-replace-me-differently
INTERNAL_CONTEXT_TTL_SECONDS=30

# ─ Security ──────────────────────────────────────────────
CORS_ORIGINS=http://localhost:5178
THROTTLE_TTL=60
THROTTLE_LIMIT=100
THROTTLE_AUTH_LIMIT=5           # stricter on /auth/login and /onboarding/signup

# ─ Argon2 (§11.6) ────────────────────────────────────────
ARGON2_MEMORY_COST=19456
ARGON2_TIME_COST=2
ARGON2_PARALLELISM=1

# ─ Frontend ──────────────────────────────────────────────
VITE_API_BASE_URL=http://localhost:3000/api/v1
```

### 22.2 Validation

Each service validates its own environment at boot with a schema, via `@nestjs/config` with
`validationSchema`. A missing or malformed variable **fails startup loudly** rather than surfacing
as a null at request time. Startup also asserts the database role is non-superuser and
`NOBYPASSRLS` (§13.8) — a misconfigured deployment refuses to boot rather than quietly disabling
tenant isolation.

### 22.3 Secret management

`.env` is git-ignored; `.env.example` is committed with placeholder values only. No secret is ever
logged — pino redacts `password`, `token`, `authorization`, `passwordHash` and `secret` paths.
Production would move these to a managed secret store; for the POC, `.env` with documented rotation
is the stated boundary.

---

## 23. Frontend Architecture

### 23.1 Principles

- **Feature-based**, not type-based. Code that changes together lives together.
- **Server state is the only real state**, owned by TanStack Query. This is why no Redux, Zustand or
  MobX appears anywhere (§4) — there is almost no client state to manage, and adding a store would
  create synchronisation bugs that do not otherwise exist.
- The UI **never** enforces security. It hides what the user cannot do; the server decides. A hidden
  button is a UX affordance, not an access control.

### 23.2 Structure

```
frontend/src/
├── app/                     App.tsx, providers, router, route guards
├── components/ui/           design system primitives (§24)
├── components/layout/       AppShell, Sidebar, Header
├── features/
│   ├── auth/                login, signup, useAuth, auth.api.ts, schemas
│   ├── organizations/       org settings, platform-admin org list
│   ├── users/               user table, invite dialog, role management
│   ├── subscriptions/       plan cards, usage meters, upgrade flow
│   ├── resources/           resource table, create/delete
│   └── audit/               audit log viewer
├── pages/                   thin route components composing features
├── services/                axios instance, interceptors, queryClient, queryKeys
├── hooks/                   cross-feature hooks
├── lib/                     cn(), formatters, constants
├── types/                   API types mirroring backend DTOs
└── utils/
```

Each feature owns `components/`, `hooks/`, `api/`, `schemas/`, `types.ts`. A feature may import from
`components/ui`, `lib`, `services`; **a feature never imports from another feature.** Shared code
moves up to `components/` or `hooks/`.

### 23.3 Data layer

`services/api-client.ts` — one axios instance:

- **Request interceptor:** attach `Authorization: Bearer`, attach `x-correlation-id`.
- **Response interceptor:** on `401`, refresh once and retry; on repeated failure, clear auth and
  redirect to login. Concurrent 401s share a single in-flight refresh promise, so a page firing five
  queries does not trigger five refreshes.
- On `403` / `404` / `409`, surface the server's structured error — in particular the
  `PLAN_LIMIT_EXCEEDED` message from §19.5, shown verbatim. The backend already wrote a clear,
  specific message; the frontend must not replace it with "Something went wrong".

Query keys are centralised and tenant-agnostic — the tenant is implicit in the token, so it never
appears in a key. Lists use TanStack Query's `placeholderData` with keyset cursors (§29).

### 23.4 Auth and routing

`AuthProvider` holds the access token **in memory** (not `localStorage` — XSS exfiltration); the
refresh token is an httpOnly cookie. On mount, the app attempts a silent refresh to restore a
session across reloads.

```
<PublicRoute>     /login   /signup
<ProtectedRoute>  requires a valid session
<RoleRoute>       requires a role — platform-admin routes are a separate branch
```

Platform-admin routes live under a distinct layout with no content-feature imports at all — the
frontend mirrors the backend's structural separation (§13.6), so a content component cannot be
mounted on a platform-admin page by accident.

### 23.5 Forms

React Hook Form + Zod. Zod schemas mirror backend DTO validation, so malformed input is caught
before a round trip — but the server validates independently, always (§25). The client-side schema
is a convenience; it is never the control.

---

## 24. Frontend Design System

Lightweight and Tailwind-based. **No component library** — MUI or shadcn-as-a-dependency would
exceed what a POC of this size needs, and the primitives below are a few hundred lines total.

### 24.1 Tokens

Tailwind theme extensions only — no CSS-in-JS, no runtime theming:

```
colors    primary · surface · border · text · success · warning · danger
spacing   Tailwind default 4px scale
radius    sm 4 · md 6 · lg 8
shadow    sm · md
```

Semantic naming (`danger`, not `red-600`) so intent survives a palette change.

### 24.2 Primitives

`components/ui/`: `Button`, `Input`, `Select`, `Checkbox`, `Label`, `FormField`, `Dialog`,
`DropdownMenu`, `Table`, `Badge`, `Alert`, `Card`, `Skeleton`, `Toast`, `Pagination`, `EmptyState`,
`UsageMeter`.

Each: variants via a small `cva`-style map, `cn()` from `clsx` + `tailwind-merge` for class merging,
`forwardRef`, native prop passthrough.

`UsageMeter` is the one domain-flavoured primitive — "4 of 5 seats used" with a warning state near
the cap. It appears on the dashboard, the users page and the subscription page, and it is the UI
surface of the limit the whole backend exists to enforce.

It shows **held seats**, which under D-Q1 includes pending invitations, and breaks the figure down
("3 users · 1 pending invite") whenever invitations hold any. An admin who sees 3 users and a
full meter must be able to tell why without opening a support ticket.

### 24.3 Tables

TanStack Table (headless) + the `Table` primitive. **Server-side pagination, sorting and filtering
throughout** — the brief requires lists to stay usable as data grows, so the client never receives
a full dataset to filter (§29).

### 24.4 Accessibility

Semantic HTML; labelled inputs; visible focus rings; dialogs trap focus, restore it on close, and
close on Escape; errors announced via `aria-live`; colour never the sole carrier of meaning.

---

## 25. Security Architecture

### 25.1 Controls

| Control | Mechanism | Where |
|---|---|---|
| Secure headers | `helmet` | Gateway + every service |
| CORS | Allowlist from `CORS_ORIGINS`; credentials enabled | Gateway only |
| Rate limiting | `@nestjs/throttler` + Redis; strict buckets on public routes | Gateway |
| Password hashing | Argon2id, tuned parameters (§11.6) | auth-service |
| Token expiry | 15 min access / 7 day refresh, single-use rotation | auth-service |
| Token revocation | Redis denylist keyed by `jti` | Gateway + auth-service |
| Input validation | Global `ValidationPipe`, `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true` | Every service |
| Authorisation | CASL (§12) | Every service |
| **Tenant isolation** | **PostgreSQL RLS (§13)** | **Database** |
| SQL injection | TypeORM parameterised queries; raw SQL always parameterised | Every service |
| Error handling | Global exception filter — never leaks stack traces, driver errors or internal paths | Every service |
| Secret separation | `JWT_SECRET` ≠ `INTERNAL_SIGNING_SECRET` | §10.5 |
| Network isolation | Only gateway and frontend publish ports | docker-compose |
| Least-privilege DB | `app_user` non-superuser, `NOBYPASSRLS`, no DDL | §13.5 |

`whitelist: true` with `forbidNonWhitelisted: true` matters specifically here: it means an
`organizationId` smuggled into a request body is **rejected**, not silently stripped — closing
bypass #6 in §13.7.

### 25.2 Error handling policy

| Situation | Response | Rationale |
|---|---|---|
| Cross-tenant resource access | `404` | `403` would confirm existence — an oracle |
| Insufficient role | `403` | The resource is in the caller's tenant; the action is not permitted |
| Invalid credentials | `401`, generic message | No user-existence oracle; dummy verify equalises timing |
| Plan limit exceeded | `409` + specific, actionable message (§19.5) | R6 requires clarity here |
| Validation failure | `400` + field-level detail | Safe; helps the caller fix it |
| Unexpected error | `500` + `correlationId` only | Detail goes to logs, never to the client |

Every error response carries `correlationId`, so a user can quote it and an operator can find the
exact trace (§26).

### 25.3 Packages deliberately not added

`csurf` (stateless JWT in a header, not cookie-based session auth for the API) · `express-session`
(no server sessions) · `bcrypt` (Argon2 specified) · `passport-local` (the login handler is a
controller; a strategy adds indirection without benefit) · any WAF or IDS (out of scope for a POC).

### 25.4 Threat model summary

| Threat | Control |
|---|---|
| Cross-tenant read by ID | RLS (§13.5) — four independent layers |
| Forged tenant context | `orgId` inside an HMAC-signed payload; services have no client-JWT path |
| Direct service access bypassing the gateway | No published ports + `InternalContextGuard` (§10.5) |
| Privilege escalation via role in request | Role comes from the signed token only; `forbidNonWhitelisted` rejects it in a body |
| Seat-limit bypass via concurrency | Row lock + `CHECK` constraint (§19) |
| Token theft | Short access TTL, in-memory storage, httpOnly refresh cookie, rotation-reuse detection |
| Brute force | Strict throttle on `/auth/login` + `AuthenticationFailed` security events |
| Platform admin viewing content | `orgId = null` → RLS returns nothing; no bypass flag exists (§13.6) |
| Enumeration via error differences | Uniform `404`; generic auth errors; timing equalised |

---

## 26. Observability / Logging

### 26.1 Structured logging

`pino` via `nestjs-pino`. JSON in every environment; pretty-printed only in local development.

Every line carries:

```json
{
  "level": "info",
  "time": "2026-09-14T10:00:00.000Z",
  "service": "user-service",
  "correlationId": "3f2e…",
  "requestId": "9a1c…",
  "organizationId": "org-uuid",
  "userId": "user-uuid",
  "method": "POST",
  "path": "/users/invite",
  "statusCode": 409,
  "durationMs": 23,
  "msg": "Plan limit exceeded"
}
```

`organizationId` is included because it is safe — an opaque identifier, not content — and because a
tenant-scoped log query is the first thing needed when investigating a suspected leak. Redaction
removes `password`, `passwordHash`, `token`, `authorization`, `secret`, `refreshToken`.

### 26.2 Correlation

`x-correlation-id` is minted at the gateway (or accepted from the client), propagated to every
downstream REST call and into every Kafka event envelope, and consumers log it too. One ID
reconstructs a full trace:

```
gateway → user-service → transaction → Kafka event → audit-service → audit_db row
```

`requestId` is per-hop; `correlationId` is per-user-action. Both are logged so a fan-out can be
distinguished from a retry.

### 26.3 The three mandated traces

The brief requires structured traces around exactly three things:

**1. Onboarding** — every saga transition logged with the saga ID and state, plus
`OrganizationCreated` / `OrganizationProvisioned` / `OnboardingFailed` in `audit_db`. A failed
onboarding can be reconstructed step by step and, critically, shows where it stopped.

**2. Plan-limit rejection** — `warn` level with `limitType`, `limit`, `current`, `planCode`,
`organizationId`, plus a `PlanLimitExceeded` audit event. Answers "how often are orgs hitting their
cap, and which ones" without a database query.

**3. Cross-tenant access attempt** — `warn` (escalated to `security` severity when the ID is known
to exist under another org) with the attempted resource ID, the actor, the actor's org, and the
correlation ID. Written to `security_events`. **This is the tenant-leak detector**: a query grouping
`security_events` by actor over a window surfaces a probing user or a buggy client immediately, not
in a post-incident review.

### 26.4 Health and readiness

Each service exposes `/health` (liveness — process is up) and `/health/ready` (readiness — database
reachable, Kafka connected, Redis reachable). Compose uses these for dependency ordering so
`docker compose up` comes up cleanly without manual retries.

**These two exact paths are the only routes in the system exempted from `InternalContextGuard`'s
signature check** — Docker Compose's healthcheck prober is a plain HTTP `GET`, with no way to
produce a signed `x-internal-context` header. The exemption is a hardcoded path comparison inside
`InternalContextGuard` (`req.path === '/health' || req.path === '/health/ready'`), not a decorator:
a decorator any controller could apply would be an extensible bypass; a fixed path list checked in
one place, reviewable in one diff, is not. Both routes return only booleans (`status`, `database`)
— there is no tenant data, no business logic, and no argument shape an attacker could use to make
this exemption do anything beyond "is the process alive". This is distinct from `@Public()`
(§11.5), which exists solely for `api-gateway`'s `JwtAuthGuard` — no downstream service's business
route is ever exempted this way (§13.7 row 6).

### 26.5 Not included

No Prometheus, Grafana, Jaeger or ELK (§4). Structured JSON logs with correlation IDs meet the
brief's requirement, and `docker compose logs | jq` is a legitimate query interface at this scale.
The upgrade path — ship the same JSON to any aggregator — needs no code change, which is precisely
why structured logging was chosen over ad-hoc strings.

---

## 27. Docker / Infrastructure

### 27.1 Containers

| Container | Image | Ports | Why |
|---|---|---|---|
| `postgres` | `postgres:17-alpine` | internal | The source of truth. RLS + row locks |
| `redis` | `redis:8-alpine` | internal | §16 — three narrow jobs |
| `kafka` | `bitnami/kafka` (**KRaft**) | internal | §17 — event backbone. KRaft removes ZooKeeper |
| `api-gateway` | local build | **3000 → host** | The only public backend entry point |
| `auth-service` | local build | internal | |
| `tenant-service` | local build | internal | |
| `user-service` | local build | internal | |
| `subscription-service` | local build | internal | |
| `resource-service` | local build | internal | |
| `audit-service` | local build | internal | |
| `frontend` | local build | **5178 → host** | SPA |

**Eleven containers, two published ports.** Every backend service except the gateway is unreachable
from the host — which is §10.5's network layer, expressed in configuration rather than in prose.

### 27.2 Database initialisation

`docker/postgres/init.sql`, run once on first boot:

1. Create the five databases.
2. Create `app_migrator` (DDL on all five) and `app_user` (DML only, **no superuser, `NOBYPASSRLS`,
   not table owner**).
3. Grant `user-service`'s role `SELECT`/`UPDATE` on `subs.subscriptions` only — the single
   documented cross-schema grant (§14.2).
4. Revoke `PUBLIC` schema creation rights.

Step 2 is what makes §13's guarantee real rather than aspirational: the runtime credential is
*incapable* of bypassing RLS.

### 27.3 Startup ordering

`depends_on` with `condition: service_healthy` chains infrastructure → migrations → services →
gateway → frontend. A one-shot `migrator` container runs every service's migrations as
`app_migrator` and exits before application services start, so no service races a schema.

Seed data (three plans: free/pro/enterprise; one platform admin) is loaded by the same one-shot
container, making `docker compose up` genuinely sufficient — the brief's requirement.

### 27.4 Not included

Kubernetes · service mesh · Prometheus/Grafana · Elasticsearch · RabbitMQ · ZooKeeper (KRaft) ·
nginx (the gateway is the entry point; a second reverse proxy adds a hop and no capability).

---

## 28. Testing Strategy

### 28.1 Pyramid

| Level | Tool | Scope |
|---|---|---|
| Unit | Jest + `@nestjs/testing` | Domain logic, ability factories, in-memory repositories. No I/O |
| Integration | Jest + **Testcontainers** | Real PostgreSQL: RLS, row locks, constraints, migrations |
| Contract | Jest | Event envelope shapes producer ↔ consumer |
| E2E | Jest + supertest | Full flows through the gateway |
| Frontend unit | **Vitest + RTL** | Components, hooks, forms |

**Testcontainers is non-negotiable for integration.** RLS policies, `FOR UPDATE` blocking behaviour
and `CHECK` constraints are PostgreSQL behaviours. A mocked repository proves nothing about any of
them — it would test the mock.

This was not a hypothetical during `user-service`'s implementation: its first concurrency test suite
used an in-memory fake that serialised every call unconditionally, regardless of whether the
production code took a real lock — a review caught that the test would pass even with
`FOR UPDATE` deleted from the repository. The fix, `test/integration/support/postgres-test-container.ts`,
is the shared helper every service's integration suite uses: it spins up a real PostgreSQL container,
creates the exact `app_migrator`/`app_user` roles `docker/postgres/init.sh` creates in the real
deployment (§13.5's `NOSUPERUSER`/`NOBYPASSRLS` property, not a superuser shortcut), runs the
service's own migration as `app_migrator`, and connects as `app_user` — the same role every service
actually runs as. `test/integration/user-service/seat-lock.integration.spec.ts` is the T3 proof this
produces: it was verified, not just written, by deliberately deleting the lock and confirming the
test fails while the unit-test suite does not. `pnpm test:integration` runs the Testcontainers suite
(tens of seconds, real Docker); `pnpm test` runs only the fast unit suite and does not include it.

### 28.2 The four tests that matter most

These are first-class deliverables, not coverage incidentals. Each maps to a brief requirement.

**T1 — Cross-tenant read by ID is impossible** (R2, the sharpest test)
```
Seed: Org A with resource RA · Org B with resource RB
Act:  authenticate as an Org A user; GET /resources/{RB.id}
Assert: 404 (not 403)
        response body contains no trace of RB
        a CrossTenantAccessAttempted security event was written
Repeat for: /users/:id, PATCH /users/:id/role, DELETE /resources/:id
```

**T2 — The careless query does not leak** (R10 — the "what if a developer forgets" test)
```
Given: a repository method with NO tenant filter, and a raw-SQL variant:
         dataSource.query('SELECT * FROM resources')
Seed:  3 resources for Org A, 2 for Org B
Act:   run it inside Org A's tenant context
Assert: exactly 3 rows returned — Org A's only
Then:  run with no tenant context at all
Assert: 0 rows — fails closed, never open
```
This test is the architecture's central claim, made executable. If it ever fails, tenant isolation
has regressed to a matter of discipline.

**T3 — Concurrent invites cannot both succeed** (R7)
```
Seed:  Org A on a 5-seat plan with 4 seats held
Act:   fire 2 invites simultaneously (Promise.all, distinct emails)
Assert: exactly 1 → 201, exactly 1 → 409 (PLAN_LIMIT_EXCEEDED)
        used_seats = 5, and it equals (active users + pending unexpired invitations)

Variants — a seat is held by a user OR a pending invitation (D-Q1), so run the
pair test across all of these; all must behave identically:
  V1  4 users + 0 pending invites
  V2  3 users + 1 pending invite
  V3  0 users + 4 pending invites
  V4  one invite racing one direct user creation
  V5  expiry sweep releases a seat (§19.9) racing an invite
  V6  invitation acceptance (§19.8) racing an invite — acceptance is net-zero,
      so the invite must still be refused
  V7  plan downgrade (§19.10) racing an invite
Invariant asserted after every variant:
        used_seats == active users + pending unexpired invitations
```

**T4 — Platform admin cannot see content** (R9)
```
Act:   authenticate as a platform admin
Assert: GET /organizations       → 200, metadata only
        GET /subscriptions/…     → 200, integer aggregates only
        GET /resources           → 403 (CASL) or empty (RLS) — never content
        GET /resources/{known}   → 404
        GET /users               → 403 or empty
Then:  sweep every registered route, asserting none returns a tenant content field
```
The route sweep matters because the brief says a platform-admin route that *happens* to expose
content is a failure even if nothing in the UI links to it. A test that enumerates routes catches
the one somebody adds later.

### 28.3 Stretch tests (brief §8)

- **50 concurrent invites** against an org two seats from its cap → exactly 2 succeed, 48 return 409.
- **Deliberate careless report endpoint** written without the tenant-scoping mechanism, demonstrated
  to return only the current tenant's rows.
- **Tenant-leak scanner**: a query finding rows whose foreign keys resolve to a different
  organisation than their owner, demonstrated against a deliberately broken seed.

### 28.4 Structural guard tests

Run in CI, per §13.8: RLS coverage, role capability assertion, table classification. These fail the
build when someone adds an unprotected table — catching the mistake at the commit, not at the breach.

### 28.5 Frontend

Vitest + RTL. Behaviour, not implementation: user-visible outcomes over internal state. MSW mocks
the API. Covered: login flow and token refresh, invite dialog surfacing the `409` message verbatim,
role-based navigation visibility, table pagination, form validation.

---

## 29. Scalability Considerations

The brief requires the org list and per-org resource lists to stay usable as data grows, and
explicitly rejects loading everything into memory and filtering in code.

| Concern | Approach |
|---|---|
| **Pagination** | **Keyset (cursor), not OFFSET.** `WHERE (created_at, id) < ($cursor_ts, $cursor_id) ORDER BY created_at DESC, id DESC LIMIT n`. OFFSET degrades linearly; keyset is constant-time regardless of depth |
| **Filtering and sorting** | Always server-side, always index-backed. The client never receives a full dataset |
| **Indexes** | Every tenant index leads with `organization_id` (§14.4), serving the RLS predicate and the query with one index |
| **Counts** | `used_seats` is the **authoritative** counter (§19.4), maintained transactionally by every seat-changing path — never a `count(*)` on the hot path, and never written by a consumer. Kafka consumers only recompute to detect drift. This is why the invite path stays O(1) as an org grows |
| **Stateless services** | No in-process state, so any service scales horizontally by replica count. Tenant context is per-request; rate limits and token state are in Redis precisely so replicas agree |
| **Kafka partitioning** | Keyed by `organizationId` — per-tenant ordering preserved while consumers scale to the partition count |
| **Connection pools** | Per service, sized independently. `resource-service` (highest volume) can be tuned without touching `auth-service` |
| **Lock contention** | Per-org row lock, so tenants never contend with each other. One org's invite burst cannot slow another's |
| **Known bottleneck** | Single PostgreSQL instance. Path: read replicas for list endpoints, then split `core_db` (§14.2), then per-tenant sharding by `organization_id` — which the schema already supports, since every tenant table carries the shard key |

---

## 30. Failure Handling

### 30.1 Onboarding partial failure (R4)

The explicit requirement: a half-created organisation must not block a retry or leave orphaned data.

Saga state machine in `tenant_db.onboarding_sagas`:

```
PENDING → ORG_CREATED → CREDENTIALS_CREATED → SUBSCRIBED → COMPLETE
                    ↓            ↓                ↓
                  FAILED (with last_error and the state reached)
```

- The organisation is created with `status = 'provisioning'` — **it cannot be logged into** until
  the saga completes, so a half-onboarded org is never usable.
- On failure, the saga records the state reached; the org becomes `provisioning_failed`.
- **Retry resumes** from the last good state, keyed by `idempotency_key` (Redis fast path, unique
  constraint as the real guarantee). A user retrying signup with the same email advances the
  existing saga rather than creating a second organisation.
- No orphan is possible: every row created is attached to the saga's `organization_id`, and the
  org row is the first thing created. There is no state where a credential exists without an org.

**Why forward-recovery rather than compensation.** Deleting a partially created organisation invites
a race with a concurrent retry, and destroys the evidence of what failed. Marking it failed and
resuming is both safer and more debuggable — and satisfies the requirement exactly as written.

### 30.2 Infrastructure failures

| Failure | Behaviour | Rationale |
|---|---|---|
| **Kafka down** | Requests **succeed**. Events buffer in memory (bounded); on overflow, log at `error` and drop | Audit must never fail a user request. Accepted loss window documented in §17.5 |
| **Redis down** | Rate limiting fails **open**; denylist fails **closed**; idempotency falls back to the unique constraint | A protection failing shut would turn a cache blip into an outage |
| **PostgreSQL down** | `503` with `Retry-After`. Readiness probe fails, so the service stops taking traffic | No fallback is possible or desirable — Postgres is the source of truth |
| **A downstream service down** | Gateway returns `503` for that route only; others unaffected | Failure is isolated by service — the point of the decomposition |
| **Consumer failure** | 3 retries with backoff, then DLQ; offset not committed, so nothing is skipped silently | At-least-once with a visible failure bucket |
| **Transaction timeout** | `statement_timeout` 5s → `503`, transaction rolled back | Better a failed request than a held lock |
| **Kafka consumer lag** | Display counters lag; **enforcement is unaffected** (§19) | Exactly why enforcement never reads the event-derived counter |
| **Expiry sweep stalls or fails** (§19.9) | Seats stay held. An org may get a 409 while genuinely under its cap | **Conservative by design** — a stalled sweep never breaches the limit, it only frees seats late. Accepted degradation; the sweep logs a warning if its last successful run is older than 2× its interval |

### 30.3 Failure mode summary

The system is designed so that **no infrastructure failure can cause a correctness failure**:

- Tenant isolation depends only on PostgreSQL, which is the source of truth anyway.
- Plan limits depend only on PostgreSQL transactions.
- Redis and Kafka failures degrade observability and convenience, never correctness.

That property is what justifies including Redis and Kafka at all in an MVP: neither can break the
two guarantees the POC is graded on.

---

## 31. Future Evolution

Ordered by likely trigger, so the next engineer knows what to do first.

| # | Change | Trigger | Path |
|---|---|---|---|
| 1 | **Split `core_db`** | Services need independent scaling, or separate teams | Seat-reservation saga inside subscription-service (§14.2). Interfaces are already in place (§20.3) |
| 2 | **Transactional outbox** | Event loss becomes unacceptable | `outbox` table written in the same transaction, drained by a poller (§17.5) |
| 3 | **Read replicas** | List endpoints dominate load | Route reads to a replica; writes and the §19 transaction stay on the primary |
| 4 | **Per-tenant sharding** | One instance is insufficient | Schema already carries `organization_id` on every tenant table — the shard key exists |
| 5 | **Multi-org users** | A user must belong to several orgs | Replace the scalar `orgId` claim with an active-org selection; `app.current_org` and every RLS policy stay unchanged — the isolation mechanism is agnostic to how `orgId` is chosen |
| 6 | **Distributed tracing** | Debugging across services outgrows correlation IDs | OpenTelemetry; correlation IDs already propagate through REST and Kafka |
| 7 | **Metrics** | Capacity planning | Prometheus + Grafana |
| 8 | **SSO / OIDC** | Enterprise requirement | New strategy in auth-service; the JWT it mints is unchanged, so nothing downstream moves |
| 9 | **Billing** | Monetisation | New service consuming `subscription.events` |
| 10 | **Kubernetes** | Beyond single-host | Services are already stateless with health probes |
| 11 | **Audit partitioning** | Audit volume outgrows one table | Monthly partitions on `occurred_at` (D-Q8 deferred this) |
| 12 | **Real email delivery** | Invitations must reach users outside a demo | `UserInvited` is already published and audited; add a consumer (D-Q6 stubbed it) |

Note what items 4, 5 and 8 have in common: each is a substantial product change that requires **no
change to the tenant isolation mechanism**. That is the strongest argument for putting the guarantee
in the database rather than in application code.

---

## 32. Resolved Decisions

All questions raised during design are **resolved**. Implementation begins with no blocking
architectural decision outstanding. Each entry states the decision, the reasoning, and the
consequence for implementation.

| # | Decision | Reasoning | Consequence |
|---|---|---|---|
| **D-Q1** | **An invite consumes a seat immediately.** A pending invitation holds a seat | Makes the §19 transaction exact. The alternative needs a second check at acceptance, by which time the limit may already be breached — a race with no good resolution | §19 counts `users + pending invitations`. Test T3 asserts against that sum |
| **D-Q2** | **Storage limit is the sum of `resources.size_bytes`** | A byte-sum limit is shaped differently from a seat count, so the POC demonstrates the pattern generalising rather than one limit twice | §19.6 locks and sums bytes; `plans.max_storage_bytes` |
| **D-Q3** | **Platform admins share the auth realm**, with `organization_id = NULL` | §13.6's guarantee *depends* on a null `orgId` flowing through the standard path. A separate realm is a second code path, and a second thing to get wrong | One login flow, one token shape. `credentials.organization_id` is nullable |
| **D-Q4** | **Downgrading below current usage is blocked** with a specific 409 | Keeps `used_seats <= max_seats_snapshot` true at all times — the §19.4 `CHECK` constraint depends on it. Grandfathering would make the invariant conditional | Plan change validates new limits against current usage inside the same transaction |
| **D-Q5** | **The last org admin cannot be removed or demoted**, 409 | An organisation with no admin is unrecoverable without platform intervention | user-service counts remaining admins inside the transaction before the write |
| **D-Q6** | **Email delivery is stubbed** — logged and audited, not sent | The invite flow is fully modelled, audited and testable without SMTP. A mail container tests nothing the brief grades | `UserInvited` is published and audited; the invitation token is returned in the API response in development |
| **D-Q7** | **Invitations expire after 7 days**, and expiry **releases the seat** | Follows directly from D-Q1: if a pending invite holds a seat, an abandoned invite must not hold it forever | `invitations.expires_at`; a periodic sweep marks them expired and decrements `used_seats` in one transaction |
| **D-Q8** | **Audit retention is unbounded for the POC** | Partitioning is an operational concern at a data volume this POC will not reach | Noted as future evolution (§31) |

### 32.1 Consequences worth restating

Two of these change what earlier sections describe, so they are spelled out rather than left
implicit:

**D-Q1 + D-Q7 define what the seat lock counts.** The §19 transaction counts
`active users + pending non-expired invitations` against `max_users`. Both an invite and a direct
user creation take the same lock on the same subscription row, so the two paths cannot race each
other. The expiry sweep takes that same lock when releasing a seat.

**D-Q4 extends the §19 pattern to plan changes.** A downgrade is a limit check like any other: lock
the subscription row, compare current usage against the *target* plan's limits, reject with a
specific 409 if usage exceeds them, otherwise update. It is the same transaction shape as an invite,
which is why §19 is written as a reusable pattern rather than a one-off.

### 32.2 Deviation from the brief's stated stack

The brief's header specifies *Express or Next.js · PostgreSQL · Prisma*. This architecture uses
**NestJS microservices + TypeORM**, per the project's own constraints, which override it. PostgreSQL
is unchanged — and it is the component every graded guarantee actually rests on (§13, §19). The
functional requirements in the brief's §3–§8 are stack-agnostic and are met in full (Appendix A).

Worth stating plainly in a walkthrough rather than glossing: the substitution was directed, and
nothing in the brief's requirements depends on the framework or ORM it happened to name.

### 32.3 Implementation-phase tracked gaps

Gaps surfaced during implementation that cannot be closed until a *later* service exists, or that
were deliberately deferred as a stated limitation rather than built now — tracked here so they are
not silently forgotten.

- **Suspended-organisation login is not yet blocked.** §11.2 lists "reject if
  `organization.status != 'active'`" as a login step. `auth-service` has no synchronous or cached
  view of organisation status — that lives in `tenant-service`. For now, a login for a *suspended*
  org (as opposed to one still `provisioning`, which never has credentials at all — §30.1's step
  order already prevents that case) is not rejected. Close this when `tenant-service` publishes
  `OrganizationSuspended` (already in the event catalogue, §17.3): `auth-service` consumes it and
  disables the affected credentials (§8.2's `credentials.status`), which the login path already
  checks.
- ~~**Immediate access-token revocation is not yet wired end to end.**~~ — **RESOLVED.** §11.4 states
  logout adds the access token's `jti` to a Redis denylist "so revocation is immediate rather than
  up-to-15-minutes late." `auth-service`'s `logout()` revokes the refresh token (the part it owns);
  the access-token denylist write was `api-gateway`'s responsibility and nothing called `deny()`
  until the gateway existed. `api-gateway`'s `AuthController.logout` now calls
  `TOKEN_DENYLIST.deny(jti, remainingTtl)` — with the jti taken from the caller's OWN
  signature-verified access token, and the TTL being that token's remaining lifetime — *before*
  forwarding to `auth-service`, so a failed downstream call still leaves the access token dead.
- ~~No `subs.subscriptions` row can exist until `subscription-service` is built~~ — **RESOLVED.**
  `subscription-service`'s `assignDefaultPlan` (§8.5) now creates that row during onboarding's
  `SUBSCRIBED` step. `user-service`'s seat-limit transactions, built and tested against the row
  before this service existed (§32.4), work unchanged now that the row is genuinely created.
- **Real seat-`used_seats` drift detection is not built — only a missing-row alarm is.** §19.4
  describes drift detection as comparing the *stored* `used_seats` against a freshly recomputed
  count. Building that inside `subscription-service` would require it to read
  `users.users`/`users.invitations` directly — technically possible (both services share one
  `app_user` role across all of `core_db`, §14.2) but exactly the cross-schema violation §14.2
  forbids ("neither service reads the other's tables for ordinary queries"). What exists instead
  (`MissingSubscriptionAlarmConsumer`, §8.5) confirms a subscription row exists whenever a
  seat-affecting event arrives, and alarms if not — a narrower, honestly-named guarantee. Real drift
  detection needs either: (a) `user-service` publishes its own computed seat count in each
  seat-affecting event's payload, and `subscription-service` compares it against `used_seats`; or
  (b) a scheduled job *inside* `user-service` itself, which already owns both the counter and the
  tables that would recompute it. Neither is built.
- **`resource-service` returns 503 for resource creation until an organisation's plan limit arrives
  over Kafka.** `plan_limit_cache` is populated asynchronously, by consuming `SubscriptionAssigned`/
  `SubscriptionChanged` (§8.6). Between an organisation being provisioned and that event being
  consumed, `PlanLimitCacheRepository.lockForUpdate` finds no row and throws `503` with a retry
  message. This is deliberate and fails closed: the alternatives were a permissive default
  (unlimited storage — a window in which the plan limit silently does not apply, strictly worse
  than a retryable failure) or a restrictive hardcoded default (fails closed correctly, but tells
  the caller "you are out of storage" when the truth is "we do not know your ceiling yet", which
  R6's clear-message requirement rules out). Close this by having onboarding's `SUBSCRIBED` step
  wait for, or synchronously seed, the cache row — or accept the window as a POC limitation.
- **A plan downgrade below current storage usage clamps `resource-service`'s ceiling rather than
  applying it.** `ck_plan_limit_storage` enforces `used_storage_bytes <= max_storage_bytes`, so
  lowering the ceiling under current usage would violate the constraint and send the event to the
  DLQ, wedging the service on a stale ceiling. §19.10 makes this rare — `subscription-service`
  rejects a downgrade below current usage inside its own locked transaction — but its check reads
  its OWN `used_storage_bytes`, which §8.5 states plainly is an eventually-consistent display value
  derived from this service's events, and which can therefore lag the authoritative counter at the
  moment it decides. The upsert therefore clamps the new ceiling to at least current usage
  (`GREATEST(excluded, used)`). Consequence, stated explicitly: for the window until usage drops,
  the organisation's effective ceiling is its usage, so every new resource is rejected while no
  existing resource is retroactively invalidated. Close this by having the downgrade path consult
  `resource-service`'s authoritative counter rather than the denormalised copy.
- **`/auth/refresh`'s public-vs-authenticated status was ambiguous in this document; resolved during
  `api-gateway`'s implementation as PUBLIC at the gateway.** §11.5's table names exactly **three**
  `@Public()` routes and does not include `/auth/refresh`, but §8.1's endpoint table lists that
  route's auth as "public (refresh token)", §9.4's anonymous-context paragraph names `/auth/refresh`
  among the routes the gateway signs anonymously, and `auth-service`'s own `AuthController`
  doc comment states `/refresh` is reachable "because the gateway signs an ANONYMOUS context" for
  it. Those statements cannot all be literally true: the gateway only signs anonymously for a route
  it treats as unauthenticated. Resolved in favour of the behaviour that makes the system work —
  `api-gateway`'s `/auth/refresh` carries `@Public()`, making **four** routes public in practice
  rather than three. The reason is mechanical, not stylistic: `JwtAuthGuard`'s Passport strategy
  validates an **access** token, and a refresh is by definition the flow a client runs *because* its
  access token has expired. Requiring one would make refresh unusable in the only situation it is
  ever called, and the refresh token is properly verified — single-use rotation, theft detection
  (§11.4) — by `auth-service`, which owns it. §11.5's "no anonymous path beyond the
  onboarding/signup flow" claim is not weakened: like `/auth/login`, this route asserts no identity,
  reads no tenant data, and its credential is a token `auth-service` itself minted and stores
  hashed. `/auth/logout` is deliberately **not** public by the same reasoning read in reverse — it
  needs the caller's own verified access token to extract the `jti` it denylists (§16.2), and
  accepting an unverified one would let any caller revoke any other caller's session. Close this by
  updating §11.5's table to name four routes and state the access-token-vs-refresh-token distinction
  explicitly, so a future reader does not have to reconstruct it from three partially-conflicting
  sections.
**Migration sequencing for `core_db` (§14.2), decided during `user-service`'s implementation.**
`subs.subscriptions` is created by `user-service`'s own migration — minimally shaped with only the
columns the §19 seat lock needs (`organization_id`, `used_seats`, `max_seats_snapshot`, and the
`CHECK` constraint) — because `subscription-service` does not exist yet and `user-service`'s
concurrency tests (T3) need a real `subs.subscriptions` row to lock against real PostgreSQL, not a
mock. When `subscription-service` is built, its own migration **extends** the same table with an
`ALTER TABLE` adding the columns it owns (`plan_id`, `status`, `used_storage_bytes`,
`max_storage_snapshot`, `current_period_end`, `version`) — never drops or recreates it. Two services
each migrating the same physical table is unusual, but it is the direct, honest consequence of the
shared-database decision §14.2 already made; the alternative (a throwaway table replaced later)
would declare the table's real owner twice and disrupt local dev data for no benefit.

### 32.4 Implementation-phase defects caught and fixed

Unlike §32.3's open gaps, these were real defects introduced during implementation and closed
before the affected service was committed. Recorded because the same mistake is exactly the kind a
later service could reintroduce if the reason it was wrong is forgotten.

- **Service-to-service HTTP calls were being sent unsigned.** `tenant-service`'s `HttpAuthClient`/
  `HttpSubscriptionClient` and an early draft of `auth-service`'s `HttpUserRoleClient` called
  `HttpService` directly, with no `x-internal-context`/`x-internal-signature` headers at all. Every
  one of these calls would have been rejected with `401` by the receiving service's
  `InternalContextGuard` at actual runtime — invisible to unit tests, which mock the client
  interface rather than exercising real HTTP. Fixed by introducing `InternalHttpClient` (§9.4) as
  the one wrapper every internal client must use, and retrofitting all three existing clients to it.
  The lesson generalises: a defect in the *wire format* between two services is exactly the class of
  bug that passes both `tsc` and a unit-test suite while being completely broken, which is why an
  end-to-end integration test exercising real HTTP between two running services belongs in the test
  plan before this system is considered complete (§28.1's Testcontainers approach extends naturally
  to spinning up two services and a real HTTP call between them, not just one service and a
  database).
- **An early draft of `AuthController` marked `/auth/login` and `/auth/refresh` as `@Public()`.**
  This would have caused `auth-service`'s own `InternalContextGuard` to skip signature verification
  entirely for those routes — the exact bypass the anonymous-context mechanism (§9.4) exists to
  avoid needing. Caught and removed before any review ran, while implementing the anonymous-context
  decision itself; recorded here because the instinct to reach for `@Public()` on a route with no
  identity yet is natural and will recur.
- **`enableTenantRls()`'s table-name quoting broke on schema-qualified tables.** The helper wrapped
  an entire `"schema.table"` string in one pair of quotes, producing a single invalid identifier
  rather than a schema-qualified reference. Every table created so far had used a bare name
  (`organizations`, `credentials`), so this passed unnoticed until `user-service`'s `users.users` —
  the first schema-qualified tenant table — required it. Fixed by quoting each dot-separated segment
  independently. A migration using this helper for a schema-qualified table is exactly the case a
  reviewer should re-verify by hand until an automated migration-apply test exists.
- **`core_db`'s init script granted `app_user` blanket CRUD on every future table in the `subs`
  schema**, via `ALTER DEFAULT PRIVILEGES ... IN SCHEMA subs ...`, rather than the narrow
  `SELECT`/`UPDATE` on `subs.subscriptions` alone that §14.2 promises. Fixed by removing the
  schema-wide default-privilege grant and applying the one specific table grant from
  `user-service`'s own migration instead, where it is reviewable next to the table it names.
- **`TenantAwareDataSource` issued `SET LOCAL app.current_org = $1` with a bind parameter** —
  PostgreSQL's `SET`/`SET LOCAL` statements do not accept bind parameters at all (`syntax error at
  or near "$1"`, confirmed against a real Postgres container). This is the single most load-bearing
  line in the entire tenant-isolation design (§13.5, §15.3) — `transaction()`,
  `transactionForOrganization()`, and `transactionWithDeferredScope()` all went through it — and it
  had never actually been exercised against a real database in any existing test: the seat-lock
  integration suite (§28.1) calls `SubscriptionSeatRepository` methods directly against raw query
  runners, bypassing this class entirely, and every unit test uses a fake `TenantAwareDataSource`.
  Fixed by switching to `SELECT set_config('app.current_org', $1, true)`, which accepts a normal
  parameterized argument and gives the identical transaction-local scoping guarantee (`true` = local)
  that `SET LOCAL` does. The lesson generalises the same way the unsigned-HTTP defect above did: a
  class every service depends on for its core safety guarantee had a codepath no test had ever
  actually run end-to-end against real Postgres, only against a fake standing in for it.
- **Bare, unqualified `@Entity('tablename')` declarations could not resolve against `core_db`'s
  custom schemas.** PostgreSQL's default `search_path` for a role with no explicit `ALTER ROLE`
  (exactly `app_user`, in every environment) is `"$user", public` — it does not include `users` or
  `subs`. `user-service`'s `User`/`Invitation` entities and `subscription-service`'s `Plan`/
  `Subscription`/`SubscriptionHistory` entities all used bare names, meaning every query against them
  would fail with "relation does not exist" against a real, non-superuser-owned database — confirmed
  empirically with a real Postgres container. `user-service`'s own `SubscriptionSeatView` was
  unaffected only because it already carried an explicit `{ schema: 'subs' }`. Fixed by setting the
  TypeOrmModule `schema` option (`'users'` / `'subs'`) at the DataSource level in each service's
  `app.module.ts` — this sets the *default* schema for any entity with no explicit `schema` of its
  own, while an entity's own explicit `schema` (as `SubscriptionSeatView` already had) still
  overrides it; both behaviours were verified against a real Postgres container before applying the
  fix. This was a latent bug in already-committed, already-reviewed `user-service` code, not just the
  in-progress `subscription-service` — caught only because the existing integration suite exercised
  `SubscriptionSeatView` (self-qualifying) and never `User`/`Invitation` directly. A new regression
  test (`test/integration/user-service/entity-schema-resolution.integration.spec.ts`) now exercises
  `User` through the real `TenantAwareDataSource` + RLS path specifically to close that gap.
- **`UsersService.updateRole`/`removeUser`/`revokeInvitation` called `findById` with no transaction
  manager**, reading against the raw injected `DataSource` rather than through
  `TenantAwareDataSource`. Discovered while building the regression test above: under `FORCE ROW
  LEVEL SECURITY`, a connection with `app.current_org` unset returns zero rows unconditionally
  (§13.6), so these three methods would have returned 404/silently-failed for every user, in every
  organization, in production — not a tenant-isolation leak, but a total functional break, invisible
  to every existing test because the unit-test fakes never model RLS and no integration test had
  called these specific methods. Fixed by moving each method's reads and writes inside a single
  `this.tenantDataSource.transaction(...)` block, passing the resulting `manager` to every repository
  call — matching the pattern every other seat-changing method in this file already used. New unit
  tests were added for both methods' not-found and last-admin-protection branches, which had zero
  coverage before (the pre-existing mocks defaulted `findById` to `null` and no test overrode it).
- **The same "unscoped `findById`" bug class, found independently by a guardian review pass over the
  three fixes above, existed in two more places the first pass missed**: `UsersReadService.getById`/
  `.listPage` (the `GET /users/:id` and `GET /users` handlers — `IUserRepository.findById`/`listPage`
  fell back to the raw `DataSource` exactly like the already-fixed `UsersService` methods, so these
  routes would 404/return-empty for every user in every org, not just a foreign one — the class's own
  doc comment incorrectly asserted RLS scoping happened "via TenantRepository", which only
  auto-injects the `organizationId` filter and does not set `app.current_org` on the connection at
  all), and `SubscriptionsService.getCurrent()` (identical shape — `findByOrganizationId` called with
  no manager). The `getCurrent()` case is worse than a plain 404: `changePlan()` ends by calling
  `getCurrent()`, so a plan change that locks the row, writes it, records history, commits, and
  publishes `SUBSCRIPTION_CHANGED` to Kafka would still surface as a 404 to the caller — a real
  operation succeeds but is reported as failed, and is not safe to blindly retry because it already
  published its event (§17.5). Fixed the same way: `UsersReadService` now opens a
  `TenantAwareDataSource.transaction(...)` for every read (its constructor doc comment's claim that
  "these never need a transaction" was the root misunderstanding — they need one purely to get
  `app.current_org` set, independent of ACID concerns), and `IUserRepository.listPage` gained a
  required `manager` parameter so its query builder can no longer silently default to the raw
  `DataSource`. `SubscriptionsService.getCurrent()` now wraps its `findByOrganizationId` + `findById`
  reads in one `tenantDataSource.transaction(...)`. `SubscriptionRepository.findByOrganizationId`'s
  optional-manager fallback was removed entirely (the parameter is now required), so a future caller
  that forgets to scope it fails at the type level rather than silently returning nothing at runtime.
  `PlanRepository` (a GLOBAL table, so not an RLS issue, but affected by the same schema-resolution
  bug) was also routed through `TenantAwareDataSource.runGlobal()` instead of a directly-injected
  `DataSource`, so each service now has exactly one database entry point — never a second, raw one
  a future method could reach for by mistake. Two new integration tests
  (`test/integration/user-service/entity-schema-resolution.integration.spec.ts`, extended to cover
  `Invitation` alongside `User` and rewritten to use the real `enableTenantRls()` helper rather than
  hand-rolled DDL; and the new
  `test/integration/subscription-service/schema-resolution-and-rls.integration.spec.ts`) exercise
  `getCurrent()` and both entities' real resolution end-to-end. The pattern across every defect in
  this section is the same: a method with an *optional* manager parameter that quietly falls back to
  an unscoped connection is a landmine — the fix that actually prevents recurrence is making the
  parameter required wherever the caller has no legitimate unscoped use case, not just remembering to
  pass it correctly at each call site. Following that principle to its source: `libs/database`'s
  shared `TenantRepository` base class — which `UserRepository` and `InvitationRepository` both
  extend, and which every future service's tenant-scoped repository is meant to extend — had the
  IDENTICAL optional-manager-falls-back-to-an-injected-unscoped-repository bug in its own `findById`/
  `save` methods. Neither existing subclass happened to call them (both fully override `findById`,
  neither uses `save`), so it was dead code rather than a live defect, but it would have silently
  reintroduced this exact bug class in the very first new service to inherit and use it unmodified.
  Fixed at the base class: `manager` is now required on both methods, and the previous
  `protected abstract get repository()` escape hatch was removed entirely in favour of a
  `protected abstract readonly entityTarget` every subclass sets once, so there is no longer any
  code path in this shared class capable of reaching an unscoped connection.
- **`set_config('app.current_org', $1, true)` reverts to the EMPTY STRING on commit, never back to
  NULL** — and that empty string persists for the rest of a pooled connection's session, since a
  connection pool reuses connections that have already served a scoped transaction. Confirmed
  empirically against a real Postgres container: before the fix below, a query on such a REUSED
  connection with no fresh scope set (`runGlobal()`, the pre-scope phase of
  `transactionWithDeferredScope`, the platform-admin "leave it unset" path) had its policy evaluate
  `organization_id = ''::uuid`, which RAISES `invalid input syntax for type uuid` — turning the H1
  cross-tenant-detection retrofit's own probe into a 500, and silently disabling the detection event
  it exists to publish. Fixed at the single shared source, `enableTenantRls()`: the policy now wraps
  the setting in `NULLIF(current_setting(...), '')` before the cast, restoring the documented
  "unscoped -> zero rows, no error" behaviour exactly, confirmed against a real container. Applied to
  every already-committed table via a follow-up migration per service (new tables get the fix
  automatically, since they all go through the same helper).
- **A SECURITY DEFINER function owned by a NOBYPASSRLS role does NOT bypass FORCE ROW LEVEL
  SECURITY — confirmed empirically, and this was a severe, previously-undetected bug in
  ALREADY-COMMITTED, production-critical code.** §13.6's narrow-exception pattern
  (`users.get_user_organization_id`, `subs.get_usage_aggregates`) was built on the assumption that
  `SECURITY DEFINER` alone makes a function "run with the owner's privileges" in a way that bypasses
  RLS. It does not, when the table is FORCE-protected: FORCE ROW LEVEL SECURITY exists specifically
  to apply the policy to the table owner too, and Postgres extends that to a SECURITY DEFINER
  function's effective owner during execution — a function owned by `app_migrator` (NOBYPASSRLS,
  every role in this system until this fix) gets no RLS bypass inside it at all, silently returning
  nothing instead of the one row/column it is meant to expose. Postgres's own error message, when an
  in-function `SET row_security = off` workaround was attempted, names the actual fix directly:
  give the owner `BYPASSRLS`.
  <br><br>
  Consequence: `users.get_user_organization_id` — which `UserRepository.findRoleByUserId` calls at
  EVERY login and token refresh, via auth-service's `resolveRoles()` — has always returned NULL in
  production, for every user, causing every real login to take the fail-closed
  "account not fully provisioned yet" branch. `subs.get_usage_aggregates` — the platform-admin usage
  view — has always returned zero rows for every organisation. Neither had ever been exercised
  against a real Postgres container; every existing test mocked `runGlobal()` rather than the
  database underneath it, so nothing could have caught this short of the empirical verification this
  codebase's testing philosophy already demanded elsewhere.
  <br><br>
  Fixed by introducing `app_rls_bypass` (docker/postgres/init.sh, and this repo's Testcontainers test
  setup): a `NOLOGIN`, `BYPASSRLS` role that nothing ever connects to directly — its only job is
  owning this narrow class of single-row, single-column lookup function. `BYPASSRLS` on this role is
  safe despite the name: it can never be connected to, so it can never be used to run an arbitrary
  query; its only capability is being the transferred owner of specific, reviewed functions that
  themselves grant `EXECUTE` narrowly to `app_user` and expose only the one column each is documented
  to return. `app_user` itself stays `NOBYPASSRLS` everywhere, unchanged — §13.8's startup check
  verifies that role, not this one. Every existing and new narrow-exception function
  (`get_user_organization_id`, `get_usage_aggregates`, and the two new ones this same round of fixes
  added — `resource_exists`, `users.user_exists`, for the H1 cross-tenant-detection retrofit) had its
  ownership transferred via a migration, with `BYPASSRLS` skipping only the POLICY check — ordinary
  object privileges (`SELECT` on the underlying table) still had to be granted separately.
  <br><br>
  Both bugs now have a real Testcontainers regression test
  (`test/integration/user-service/security-definer-bypass.integration.spec.ts`,
  `test/integration/subscription-service/security-definer-bypass.integration.spec.ts`) that exercises
  the actual production function against a real Postgres container and was verified, by temporarily
  reverting the ownership transfer, to fail without the fix.
- **(2026-09-16, while building `audit-service`) The standard `enableTenantRls()` policy shape
  REJECTS an insert of a row whose `organization_id` is NULL, from an unscoped transaction** — which
  would have made every platform-level security event permanently unwritable. `audit_events` and
  `security_events` are the only tables in the system with a NULLABLE `organization_id` (§8.7), and
  the null case is real rather than theoretical: auth-service's `publishAuthFailure` emits
  `AuthenticationFailed` with `organizationId: null` when a login fails for an email that maps to no
  credential, because there is no organisation to attach — establishing one is precisely what failed.
  Under the helper's predicate, `organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid`
  evaluates with NULL on both sides, yielding NULL — and `WITH CHECK` admits only rows for which the
  expression is TRUE, rejecting NULL exactly as it rejects FALSE. Confirmed against a real Postgres 17
  container as the real `app_user` role BEFORE the migration was written (`ERROR: new row violates
  row-level security policy`), not assumed from reading the predicate. The failure mode it would have
  produced is the quiet kind: every platform-level `AuthenticationFailed` event would throw in the
  consumer, retry three times and dead-letter, silently disabling the brute-force-detection half of
  §8.7 while the org-scoped half kept working and the service kept reporting healthy.
  <br><br>
  Fixed LOCALLY, in audit-service's own migration for those two tables only, with one added disjunct
  (`OR (organization_id IS NULL AND NULLIF(current_setting('app.current_org', true), '') IS NULL)`)
  on both `USING` and `WITH CHECK`. `enableTenantRls()` itself is deliberately unchanged: every other
  table's `organization_id` is `NOT NULL`, so the disjunct could never fire for them, but widening
  the single most load-bearing predicate in the architecture to serve two tables that can carry their
  own policy is not a trade worth making. The same container run confirmed the isolation half is
  unweakened — an unscoped transaction still cannot plant a row in an organisation, an org-scoped
  transaction cannot write a platform-level row, and an org-scoped READ sees neither another org's
  rows nor the platform-level ones.
  `test/integration/audit-service/rls-and-append-only.integration.spec.ts` re-proves the standard
  shape's rejection against a throwaway table built with the helper's exact policy, alongside the
  audit tables accepting the identical insert, so a later "simplification" back to
  `enableTenantRls()` fails loudly rather than silently breaking platform-level security events.
- **(2026-09-16) `FORCE ROW LEVEL SECURITY` also defeats the table OWNER's unscoped `DELETE`, which
  silently no-ops instead of erroring.** Found while writing audit-service's integration suite, whose
  `beforeEach` cleared both tables as `app_migrator` (necessarily — `app_user` holds no `DELETE` on
  them at all, by §8.7's append-only grant). Because `FORCE` applies the policy to the owner too, the
  unscoped `DELETE FROM audit_events` matched only the NULL-org rows and left every tenant's rows in
  place; rows accumulated across tests until isolation assertions started counting three org-A rows
  where they expected one. The tests caught it, but the failure presented as an isolation problem
  rather than a teardown problem, which cost time to read correctly — worth recording because any
  future suite over a `FORCE`-protected table will hit the identical trap. Fixed by using `TRUNCATE`,
  which is not row-filtered and so is not subject to the policy. Nothing in production code was
  affected: no service deletes from an RLS table unscoped. The behaviour is itself reassuring — it is
  the same mechanism that makes the surrounding assertions meaningful.
- **(2026-09-16) `TenantRepository`'s generic constraint was `T extends TenantBaseEntity`, which no
  append-only entity can satisfy.** `audit_events`/`security_events` are genuinely tenant-owned —
  `organization_id`, `TENANT_TABLES`, `ENABLE` + `FORCE` RLS, the lot — but carry no
  `updated_at`/`deleted_at` (an audit row is never updated and never soft-deleted; the database GRANT
  forbids both) and have a nullable `organization_id`. The constraint would have forced their
  repositories to either fake those columns or skip `TenantRepository` entirely, putting the one pair
  of repositories with an unusual shape OUTSIDE the defence-in-depth layer — exactly backwards.
  Widened to a new `TenantScopedEntity` interface declaring only what the class's own two concrete
  methods use (`id`, `organizationId`), which `TenantBaseEntity` satisfies unchanged, so every
  existing subclass is unaffected. The `organizationId` getter still returns a non-null `string` or
  throws, so no subclass gains the ability to write an unscoped row through the inherited methods.
- **`InvitationsController.accept()` and `OnboardingController.signup()` carried `@app/tenant-context`'s
  `Public()` decorator — a real, already-committed defect, found while designing `api-gateway`.**
  `InternalContextGuard`'s own doc comment states plainly that a downstream service must never
  declare a route `@Public()` itself (§13.7 row 6) — that decorator exists ONLY for `api-gateway`'s
  `JwtAuthGuard` (a *different* `Public()`, from `libs/auth`, sharing the same metadata key by
  design so a route is public for both guards at once — but that equivalence only holds at the
  gateway, which has `JwtAuthGuard`; a downstream service has `InternalContextGuard` instead, and
  applying the SAME decorator there skips signature verification entirely). Both routes were
  reachable with no `x-internal-context` signature check at all — the exact bypass the whole
  system's isolation-bypass story (§9.4's "exactly one shape everywhere") depends on not existing.
  Fixed by removing the decorator from both controllers; each route now goes through
  `InternalContextGuard` like every other route in its service, verifying the ANONYMOUS context
  `api-gateway` signs for it (§9.4) — the handler still has no caller identity to read, since none
  exists yet, but the signature (proving the request came through the gateway) is checked.

---

## Appendix A — Requirements Traceability

| Req | Requirement | Section | Test |
|---|---|---|---|
| R1 | Org owns its users and data | §8, §14 | T1 |
| **R2** | **No cross-tenant access, including by ID** | **§13** | **T1, T2** |
| R3 | Self-service onboarding | §8.3, §30.1 | E2E |
| R4 | Onboarding partial failure | §30.1 | Saga tests |
| R5 | Plans define limits; downgrade blocked below usage (D-Q4) | §8.5, §14.3, §19.10 | Unit, T3-V7 |
| R6 | Clear, specific limit refusal, naming pending invites | §19.5, §19.10 | T3 |
| **R7** | **Concurrent limit correctness** (all seat paths) | **§19.2, §19.4, §19.8–19.10** | **T3 V1–V7, 50-burst** |
| R8 | Org admin scoped to own org | §12.3, §13 | T1 |
| R9 | Platform admin sees no content | §13.6, §12.3 | T4 |
| R10 | Structural tenant scoping | §13.5 | **T2** |
| — | Bad input rejected pre-logic | §25.1 | Validation tests |
| — | No anonymous path beyond signup | §11.5 | Route audit |
| — | Lists scale | §29 | Pagination tests |
| — | Structured traces | §26.3 | Audit tests |
| — | `docker compose up` | §27 | Manual |

## Appendix B — Decision Log

| # | Decision | Alternatives rejected | Why |
|---|---|---|---|
| D1 | PostgreSQL RLS for tenant isolation | Repository-only filtering; middleware query rewriting | Only RLS survives a developer forgetting, and covers raw SQL |
| D2 | 7 services | 3–4 merged; 10+ granular | Each of the 7 owns distinct data with a distinct access profile (§7.2, §7.3) |
| D3 | `core_db` shared by user + subscription | Separate DBs + saga; 2PC | A provable ACID guarantee beats a more distributed diagram (§14.2) |
| D4 | Row lock + authoritative `used_seats` + `CHECK` | Redis lock; optimistic; Kafka; live `count(*)` on the hot path | Transactional and correct under partition; one quantity, not two (§19.4, §19.11) |
| D5 | Kafka + Redis, narrow jobs | Either alone | Each solves a problem the other cannot (§18.2) |
| D6 | CASL in services, coarse checks at gateway | Gateway-only; service-only | The gateway lacks the subject (§12.4) |
| D7 | `AsyncLocalStorage` for context | Request-scoped DI; parameter threading | Reaches TypeORM internals, where scoping must apply (§13.4) |
| D8 | REST + signed header between services | gRPC; NestJS TCP transport | Debuggable with curl; no codegen; signature prevents forgery (§9.4) |
| D9 | No client state library | Redux; Zustand | Server state is the only real state (§23.1) |
| D10 | `404` on cross-tenant access | `403` | `403` is an existence oracle (§13.9) |
| D11 | Forward-recovery onboarding saga | Compensating deletion | Safer under retry races; preserves evidence (§30.1) |
| D12 | Testcontainers for integration | Mocked repositories | RLS and locks are database behaviours; mocks would test the mock (§28.1) |
| D13 | A pending invitation holds a seat | Seat counted only on acceptance | Makes the §19 check exact; the alternative races at acceptance (D-Q1) |
| D14 | Invitations expire in 7 days, releasing the seat | Never expire | Follows from D13 — an abandoned invite must not hold a seat forever (D-Q7) |
| D15 | Downgrade below current usage blocked | Grandfather until usage falls | Keeps the §19.4 `CHECK` invariant unconditionally true (D-Q4) |
| D16 | Invitation-accept is the third `@Public()` route | Require auth; pre-create the account | An invitee has no account yet; the single-use hashed token is the credential and carries its own tenant scope (§11.5) |
| D17 | Email stubbed, not delivered | MailHog container | The invite flow is fully modelled and audited without SMTP (D-Q6) |
