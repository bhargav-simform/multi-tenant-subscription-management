import { Injectable } from '@nestjs/common';
import { AbilityBuilder, Ability } from '@casl/ability';
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
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(Ability);

    if (ctx.roles.includes(Role.PLATFORM_ADMIN)) {
      can(Action.READ, Subject.ORGANIZATION);
      can(Action.READ, Subject.SUBSCRIPTION);
      can(Action.READ, Subject.PLAN);
      can(Action.MANAGE, Subject.PLAN);
      can(Action.READ, Subject.AUDIT_EVENT);
      cannot(Action.READ, Subject.RESOURCE); // §12.3, §13.6 — explicit, not absent
      cannot(Action.READ, Subject.USER); // §12.3, §13.6 — explicit, not absent
    }

    if (ctx.roles.includes(Role.ORG_ADMIN)) {
      can(Action.MANAGE, Subject.USER, { organizationId: ctx.organizationId });
      can(Action.MANAGE, Subject.RESOURCE, { organizationId: ctx.organizationId });
      can(Action.READ, Subject.ORGANIZATION, { id: ctx.organizationId });
      can(Action.READ, Subject.SUBSCRIPTION, { organizationId: ctx.organizationId });
      can(Action.UPDATE, Subject.SUBSCRIPTION, { organizationId: ctx.organizationId });
      can(Action.READ, Subject.AUDIT_EVENT, { organizationId: ctx.organizationId });
      can(Action.READ, Subject.PLAN);
    }

    if (ctx.roles.includes(Role.ORG_MEMBER)) {
      can(Action.READ, Subject.RESOURCE, { organizationId: ctx.organizationId });
      can(Action.CREATE, Subject.RESOURCE);
      can(Action.UPDATE, Subject.RESOURCE, {
        organizationId: ctx.organizationId,
        createdBy: ctx.userId,
      });
      can(Action.DELETE, Subject.RESOURCE, {
        organizationId: ctx.organizationId,
        createdBy: ctx.userId,
      });
      can(Action.READ, Subject.USER, { id: ctx.userId });
      can(Action.READ, Subject.ORGANIZATION, { id: ctx.organizationId });
      cannot(Action.MANAGE, Subject.USER);
    }

    return build();
  }
}
