import {
  AbilityBuilder,
  createMongoAbility,
  type ForcedSubject,
  type MongoAbility,
} from '@casl/ability';
import { Action, Role, Subject } from '../types/constants';
import type { TenantContextPayload } from '../types/tenant-context';

/*
 * Subjects are checked by string tag, not by class. Each tagged instance type lists
 * the fields the conditions below use, so CASL can type-check them.
 */
type OrganizationInstance = { id: string } & ForcedSubject<Subject.ORGANIZATION>;
type UserInstance = { id: string; organizationId: string } & ForcedSubject<Subject.USER>;
type SubscriptionInstance = { organizationId: string } & ForcedSubject<Subject.SUBSCRIPTION>;
type ResourceInstance = {
  organizationId: string;
  createdBy: string;
} & ForcedSubject<Subject.RESOURCE>;
type AuditEventInstance = { organizationId: string } & ForcedSubject<Subject.AUDIT_EVENT>;

export type AppSubjects =
  | Subject.ORGANIZATION
  | OrganizationInstance
  | Subject.USER
  | UserInstance
  | Subject.SUBSCRIPTION
  | SubscriptionInstance
  | Subject.PLAN
  | Subject.RESOURCE
  | ResourceInstance
  | Subject.AUDIT_EVENT
  | AuditEventInstance
  | 'all';

export type AppAbility = MongoAbility<[Action, AppSubjects]>;

/**
 * Builds a CASL ability from tenant context. This is authorization ("what may you
 * do?"), never tenant isolation ("whose data may you touch?" — that is RLS). The
 * { organizationId } conditions are for readable intent, not the boundary.
 *
 * The two `cannot` rules for PLATFORM_ADMIN are explicit rather than merely absent,
 * so a reviewer can point at them; RLS enforces the same boundary independently.
 */
export function createAbilityForContext(ctx: TenantContextPayload): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  if (ctx.roles.includes(Role.PLATFORM_ADMIN)) {
    can(Action.READ, Subject.ORGANIZATION);
    can(Action.READ, Subject.SUBSCRIPTION);
    can(Action.READ, Subject.PLAN);
    can(Action.MANAGE, Subject.PLAN);
    can(Action.READ, Subject.AUDIT_EVENT);
    cannot(Action.READ, Subject.RESOURCE);
    cannot(Action.READ, Subject.USER);
  }

  // organizationId/userId are null only for a platform admin or the anonymous
  // context — neither ever carries an org role. Asserted once here so a broken
  // invariant fails loudly instead of building a condition against null.
  if (ctx.roles.includes(Role.ORG_ADMIN) || ctx.roles.includes(Role.ORG_MEMBER)) {
    if (ctx.organizationId === null || ctx.userId === null) {
      throw new Error(
        'createAbilityForContext: an org-scoped role has no organizationId/userId. ' +
          'This is a bug in whatever minted this context.',
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
    // Org-wide: the Users page and the dashboard's recent-users card show every teammate.
    can(Action.READ, Subject.USER, { organizationId });
    can(Action.READ, Subject.ORGANIZATION, { id: organizationId });
    can(Action.READ, Subject.SUBSCRIPTION, { organizationId });
    // Not cannot(MANAGE, USER): MANAGE is a wildcard that would revoke READ too.
    cannot(Action.CREATE, Subject.USER);
    cannot(Action.UPDATE, Subject.USER);
    cannot(Action.DELETE, Subject.USER);
  }

  return build();
}
