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

Reference: `docs/architecture/ARCHITECTURE.md` §12.

## Keep three questions separate

| Question | Mechanism | Failure |
|---|---|---|
| Who are you? | JWT + Passport (gateway) | 401 |
| **What may you do?** | **CASL (in services)** | **403** |
| Whose data may you touch? | PostgreSQL RLS | 404 + security event |

**CASL is never the tenant isolation mechanism.** A condition like
`{ organizationId: ctx.orgId }` is a convenience that produces good errors — it is
never what stands between Org A and Org B. That is RLS. Conflating them means a
forgotten CASL rule becomes a data leak instead of a permissions bug.

## Actions and subjects

```
Action:  'create' | 'read' | 'update' | 'delete' | 'manage'
Subject: 'Organization' | 'User' | 'Subscription' | 'Plan' | 'Resource' | 'AuditEvent' | 'all'
```

Adding an action or subject requires updating the ability factory for all three roles —
an unlisted subject silently denies, which is safe but confusing to debug.

## Role abilities

**Platform Admin** (`orgId = null`)
```ts
can('read', 'Organization');                          // metadata only
can('read', 'Subscription');                          // aggregates only
can('manage', 'Plan');
can('read', 'AuditEvent', { severity: 'security' });
cannot('read', 'Resource');   // ← explicit, R9
cannot('read', 'User');       // ← explicit, R9
```
The two `cannot` rules are deliberately explicit rather than merely absent, so a
reviewer can point at them. RLS enforces the same boundary independently.

**Org Admin**
```ts
can('manage', 'User',         { organizationId: ctx.orgId });
can('manage', 'Resource',     { organizationId: ctx.orgId });
can('read',   'Organization', { id: ctx.orgId });
can('read',   'Subscription', { organizationId: ctx.orgId });
can('update', 'Subscription', { organizationId: ctx.orgId });
can('read',   'AuditEvent',   { organizationId: ctx.orgId });
can('read',   'Plan');
```

**Org Member**
```ts
can('read',   'Resource', { organizationId: ctx.orgId });
can('create', 'Resource');
can('update', 'Resource', { organizationId: ctx.orgId, createdBy: ctx.userId });
can('delete', 'Resource', { organizationId: ctx.orgId, createdBy: ctx.userId });
can('read',   'User',     { id: ctx.userId });        // self only
cannot('manage', 'User');
```

## Where checks live

| Layer | Does | Why |
|---|---|---|
| api-gateway | Coarse route-level role check only | Cheap rejection before a network hop; it has the `roles` claim |
| **Each service** | **Full ability check including subject conditions** | **The gateway does not have the subject.** To evaluate a rule conditioned on `organizationId`, you must have loaded the row |

If the gateway's check were removed, nothing becomes insecure. If a service's check
were removed, something does.

## Enforcement pattern

```ts
@Patch(':id/role')
@CheckAbility(Action.Update, Subject.User)
async changeRole(@Param('id') id: string, @Body() dto: ChangeRoleDto) { … }
```

`CaslAbilityGuard` reads context from `AsyncLocalStorage` — **never from `req`** —
builds the ability and checks the declared permission. For subject-conditioned rules,
the service loads the subject (already RLS-scoped, so a foreign-tenant row is simply
absent) and calls `ability.can(action, subject('User', loaded))`.

**Ordering matters.** RLS runs first, so a cross-tenant ID yields 404 before CASL is
consulted. A 403 there would confirm the resource exists.

## Checklist

- [ ] Every non-public route carries `@CheckAbility`
- [ ] New subject registered in the ability factory for all three roles
- [ ] Subject-conditioned rules check the **loaded** subject, not just the type
- [ ] Ability built from ALS context, never from `req`
- [ ] Tenant isolation is **not** relying on a CASL condition
- [ ] Platform-admin `cannot` rules for `Resource` and `User` still present
- [ ] Tests cover all three roles, including the denied cases
