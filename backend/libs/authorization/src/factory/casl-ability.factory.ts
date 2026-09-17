import { Injectable } from '@nestjs/common';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { Action, Role, Subject, type TenantContextPayload } from '@app/common';
import type { AppAbility } from './app-ability.type';

/**
 * Builds a CASL ability from tenant context (§12.3). This is authorization ("what
 * may you do?"), never tenant isolation ("whose data may you touch?" — that is
 * RLS, §13). A condition like { organizationId: ctx.orgId } here is a convenience
 * for a good error message; it is never what stands between two tenants.
 *
 * The two `cannot` rules for PLATFORM_ADMIN are deliberately explicit rather than
 * merely absent (§12.3) — a reviewer can point at them, and RLS enforces the same
 * boundary independently, so both must fail for platform admin content access.
 */
@Injectable()
export class CaslAbilityFactory {
  createForContext(ctx: TenantContextPayload): AppAbility {
    // BUG FIX (found via the frontend's /organizations/me integration, after
    // fixing the ALS-scope-ordering bug in TenantContextMiddleware exposed
    // this one underneath it): `new AbilityBuilder<AppAbility>(Ability)` built
    // an ability with NO conditions matcher configured, so the very first
    // conditional `can()` rule below (any role but PLATFORM_ADMIN reaches one)
    // threw "Cannot restrict access by conditions without a conditionsMatcher
    // option" the moment CaslAbilityGuard called `ability.can(...)` — a 500 on
    // every authorization check that wasn't a platform admin's unconditional
    // rule. `createMongoAbility` is CASL's ability constructor with the
    // MongoDB-query-style conditions matcher already wired in, which is what
    // every `{ organizationId: ctx.organizationId }`-style condition here
    // needs to be evaluated at all.
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

    if (ctx.roles.includes(Role.PLATFORM_ADMIN)) {
      can(Action.READ, Subject.ORGANIZATION);
      can(Action.READ, Subject.SUBSCRIPTION);
      can(Action.READ, Subject.PLAN);
      can(Action.MANAGE, Subject.PLAN);
      can(Action.READ, Subject.AUDIT_EVENT);
      cannot(Action.READ, Subject.RESOURCE); // §12.3, §13.6 — explicit, not absent
      cannot(Action.READ, Subject.USER); // §12.3, §13.6 — explicit, not absent
    }

    // organizationId is null ONLY for a platform admin, and userId is null
    // ONLY for the anonymous context of the three @Public() gateway routes
    // (see TenantContextPayload's own doc comment) — neither case ever
    // carries ORG_ADMIN or ORG_MEMBER in its roles, so both are guaranteed
    // non-null inside these two branches. Narrowed once here rather than at
    // every call site below, both for the condition objects' string-only
    // types and so a future change to either invariant fails loudly at this
    // one assertion instead of silently building a condition against `null`.
    if (ctx.roles.includes(Role.ORG_ADMIN) || ctx.roles.includes(Role.ORG_MEMBER)) {
      if (ctx.organizationId === null || ctx.userId === null) {
        throw new Error(
          'CaslAbilityFactory: an org-scoped role was signed with no organizationId/userId. ' +
            'This is a bug in whatever minted this context, not a case this factory can handle safely.',
        );
      }
    }

    if (ctx.roles.includes(Role.ORG_ADMIN)) {
      const organizationId = ctx.organizationId as string;
      can(Action.MANAGE, Subject.USER, { organizationId });
      can(Action.MANAGE, Subject.RESOURCE, { organizationId });
      can(Action.READ, Subject.ORGANIZATION, { id: organizationId });
      can(Action.READ, Subject.SUBSCRIPTION, { organizationId });
      can(Action.UPDATE, Subject.SUBSCRIPTION, { organizationId });
      can(Action.READ, Subject.AUDIT_EVENT, { organizationId });
      can(Action.READ, Subject.PLAN);
    }

    if (ctx.roles.includes(Role.ORG_MEMBER)) {
      const organizationId = ctx.organizationId as string;
      const userId = ctx.userId as string;
      can(Action.READ, Subject.RESOURCE, { organizationId });
      can(Action.CREATE, Subject.RESOURCE);
      can(Action.UPDATE, Subject.RESOURCE, { organizationId, createdBy: userId });
      can(Action.DELETE, Subject.RESOURCE, { organizationId, createdBy: userId });
      can(Action.READ, Subject.USER, { id: userId });
      can(Action.READ, Subject.ORGANIZATION, { id: organizationId });
      cannot(Action.MANAGE, Subject.USER);
    }

    return build();
  }
}
