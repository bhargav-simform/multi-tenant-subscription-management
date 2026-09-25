---
name: casl-authorization
description: >
  Wire or audit CASL authorization. Use when: adding a route that needs permission
  checks, defining abilities for a role, adding a new subject type, debugging a
  403, or when the user says "add permissions", "authorization", "CASL", "RBAC",
  "who can do this", "role check". CASL is for authorization only, never for
  tenant isolation.
---

# CASL Authorization

Reference: `docs/architecture/ARCHITECTURE.md` §12 (with the §0 / §12.4 notes). Code:
`backend/src/lib/casl.ts`, `backend/src/middlewares/authorize.ts`,
`backend/src/types/constants.ts`.

## Keep three questions separate

| Question | Mechanism | Failure |
|---|---|---|
| Who are you? | JWT, verified by `middlewares/authenticate.ts` | 401 |
| **What may you do?** | **CASL** (`authorize` middleware + row checks in services) | **403** |
| Whose data may you touch? | PostgreSQL RLS (`lib/tenant-db.ts`) | 404 + security event |

**CASL is never the tenant isolation mechanism.** A condition like
`{ organizationId }` is readable intent — it is never what stands between Org A and
Org B. That is RLS. Conflating them means a forgotten CASL rule becomes a data leak
instead of a permissions bug.

## Actions and subjects

Enums in `types/constants.ts` — never raw strings:

```
Action:  CREATE | READ | UPDATE | DELETE | MANAGE
Subject: ORGANIZATION | USER | SUBSCRIPTION | PLAN | RESOURCE | AUDIT_EVENT | ALL
```

Adding a subject means: the enum, a tagged instance type in `lib/casl.ts` (`AppSubjects`),
and rules for **all three roles** — an unlisted subject silently denies, which is safe
but confusing to debug.

## Role abilities (as implemented in `createAbilityForContext`)

**Platform Admin** (`organizationId = null`)
```ts
can(READ, ORGANIZATION); can(READ, SUBSCRIPTION); can(READ, PLAN); can(MANAGE, PLAN);
can(READ, AUDIT_EVENT);
cannot(READ, RESOURCE);   // ← explicit, R9
cannot(READ, USER);       // ← explicit, R9
```
The two `cannot` rules are deliberately explicit, so a reviewer can point at them. RLS
enforces the same boundary independently (a null org sees zero tenant rows).

**Org Admin**
```ts
can(MANAGE, USER,         { organizationId });
can(MANAGE, RESOURCE,     { organizationId });
can(READ,   ORGANIZATION, { id: organizationId });
can(READ,   SUBSCRIPTION, { organizationId });
can(UPDATE, SUBSCRIPTION, { organizationId });   // plan change
can(READ,   AUDIT_EVENT,  { organizationId });
can(READ,   PLAN);
```

**Org Member**
```ts
can(READ,   RESOURCE,     { organizationId });
can(CREATE, RESOURCE);
can(UPDATE, RESOURCE,     { organizationId, createdBy: userId });
can(DELETE, RESOURCE,     { organizationId, createdBy: userId });
can(READ,   USER,         { organizationId });   // org-wide: Users page + dashboard card
can(READ,   ORGANIZATION, { id: organizationId });
can(READ,   SUBSCRIPTION, { organizationId });
cannot(CREATE, USER); cannot(UPDATE, USER); cannot(DELETE, USER);
// NOT cannot(MANAGE, USER): MANAGE is a wildcard and would revoke READ too
```

An org role with a null `organizationId`/`userId` throws — that is a bug in whatever
minted the context, and it must fail loudly.

## Where checks live

| Check | Where | What it can see |
|---|---|---|
| Platform-admin-only route | `requirePlatformAdmin` (route middleware, before CASL) | `req.user.roles` |
| Subject-type permission | `authorize(Action, Subject)` on the route | The context only — checks the subject **type** |
| Mid-handler type check | `assertCan(Action, Subject)` — e.g. each half of `GET /dashboard` | Same |
| Row-conditioned rule (e.g. members delete only their own resource) | The **service**, after the RLS-scoped read | The loaded row |

`authorize` cannot evaluate a condition like `createdBy: userId` — it has no row. The
service must check the loaded row (see `assertMayModify` in `resources.service.ts`)
and throw `ForbiddenException`.

## Enforcement pattern

```ts
router.patch(
  '/users/:id/role',
  throttle, authenticate,
  authorize(Action.UPDATE, Subject.USER),
  validateBody(UpdateRoleDto),
  users.updateRole,
);
```

The ability is built from `contextStore.getOrThrow()` — **never from `req`**. A denial
is `403 { message: 'You do not have permission to <action> <Subject>', error: 'Forbidden', statusCode: 403 }`.

**Ordering matters.** For by-id routes the RLS-scoped read runs in the service; a
foreign-tenant id is simply absent and yields 404 before any row-level CASL check. A 403
there would confirm the resource exists.

## Checklist

- [ ] Every authenticated route carries `authorize(...)` (or `assertCan` in the controller)
- [ ] Platform-admin-only routes carry `requirePlatformAdmin` before `authorize`
- [ ] New subject: enum + `AppSubjects` type + rules for all three roles
- [ ] Row-conditioned rules checked in the service against the **loaded** row
- [ ] Ability built from `contextStore`, never from `req`
- [ ] Tenant isolation is **not** relying on a CASL condition
- [ ] Platform-admin `cannot` rules for `Resource` and `User` still present
- [ ] Tests cover all three roles, including the denied cases
