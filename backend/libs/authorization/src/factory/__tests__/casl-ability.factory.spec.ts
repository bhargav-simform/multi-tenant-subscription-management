import { describe, it, expect } from '@jest/globals';
import { Action, Role, Subject, type TenantContextPayload } from '@app/common';
import { CaslAbilityFactory } from '../casl-ability.factory';

/**
 * THE regression this file exists to prevent: `new AbilityBuilder<AppAbility>(Ability)`
 * built an ability with no conditions matcher, so `ability.can(...)` threw
 * "Cannot restrict access by conditions without a conditionsMatcher option" the
 * moment it evaluated any conditional rule — every rule below except a platform
 * admin's unconditional ones. Every test therefore calls `.can()`/`.cannot()`
 * (not just `createForContext()` itself) — merely building the ability without
 * evaluating a rule against it would NOT have caught this bug, since the
 * exception only threw once evaluation was attempted.
 */
describe('CaslAbilityFactory', () => {
  const factory = new CaslAbilityFactory();

  const ORG_ID = 'org-1';
  const OTHER_ORG_ID = 'org-2';
  const USER_ID = 'user-1';

  function contextFor(overrides: Partial<TenantContextPayload>): TenantContextPayload {
    return {
      userId: USER_ID,
      organizationId: ORG_ID,
      roles: [],
      correlationId: 'corr-1',
      iat: 0,
      exp: 0,
      ...overrides,
    };
  }

  describe('ORG_ADMIN', () => {
    const ctx = contextFor({ roles: [Role.ORG_ADMIN] });
    const ability = factory.createForContext(ctx);

    it('can manage users within their own organisation — does not throw', () => {
      expect(() => ability.can(Action.MANAGE, { __caslSubjectType__: Subject.USER, id: USER_ID, organizationId: ORG_ID })).not.toThrow();
    });

    it('can manage a user in their own org', () => {
      expect(
        ability.can(Action.MANAGE, {
          __caslSubjectType__: Subject.USER,
          id: 'other-user',
          organizationId: ORG_ID,
        }),
      ).toBe(true);
    });

    it('cannot manage a user in a DIFFERENT organisation (§13 — CASL is not the isolation boundary, but it must not contradict it)', () => {
      expect(
        ability.can(Action.MANAGE, {
          __caslSubjectType__: Subject.USER,
          id: 'other-user',
          organizationId: OTHER_ORG_ID,
        }),
      ).toBe(false);
    });

    it('can read the plan catalogue unconditionally', () => {
      expect(ability.can(Action.READ, Subject.PLAN)).toBe(true);
    });
  });

  describe('ORG_MEMBER', () => {
    const ctx = contextFor({ roles: [Role.ORG_MEMBER] });
    const ability = factory.createForContext(ctx);

    it('can read a resource in their own organisation', () => {
      expect(
        ability.can(Action.READ, {
          __caslSubjectType__: Subject.RESOURCE,
          organizationId: ORG_ID,
          createdBy: 'anyone',
        }),
      ).toBe(true);
    });

    it('cannot read a resource in a different organisation', () => {
      expect(
        ability.can(Action.READ, {
          __caslSubjectType__: Subject.RESOURCE,
          organizationId: OTHER_ORG_ID,
          createdBy: 'anyone',
        }),
      ).toBe(false);
    });

    it('can update/delete only their OWN resource', () => {
      const own = { __caslSubjectType__: Subject.RESOURCE as const, organizationId: ORG_ID, createdBy: USER_ID };
      const someoneElses = { __caslSubjectType__: Subject.RESOURCE as const, organizationId: ORG_ID, createdBy: 'other-user' };

      expect(ability.can(Action.UPDATE, own)).toBe(true);
      expect(ability.can(Action.UPDATE, someoneElses)).toBe(false);
      expect(ability.can(Action.DELETE, own)).toBe(true);
      expect(ability.can(Action.DELETE, someoneElses)).toBe(false);
    });

    it('cannot manage users at all', () => {
      expect(
        ability.can(Action.MANAGE, {
          __caslSubjectType__: Subject.USER,
          id: USER_ID,
          organizationId: ORG_ID,
        }),
      ).toBe(false);
    });
  });

  describe('PLATFORM_ADMIN', () => {
    const ctx = contextFor({ userId: null, organizationId: null, roles: [Role.PLATFORM_ADMIN] });
    const ability = factory.createForContext(ctx);

    it('can read organisations, subscriptions, plans and audit events — metadata only', () => {
      expect(ability.can(Action.READ, Subject.ORGANIZATION)).toBe(true);
      expect(ability.can(Action.READ, Subject.SUBSCRIPTION)).toBe(true);
      expect(ability.can(Action.READ, Subject.PLAN)).toBe(true);
      expect(ability.can(Action.READ, Subject.AUDIT_EVENT)).toBe(true);
    });

    it('cannot read resources or users — explicit, not merely absent (§12.3, §13.6)', () => {
      expect(ability.can(Action.READ, Subject.RESOURCE)).toBe(false);
      expect(ability.can(Action.READ, Subject.USER)).toBe(false);
    });
  });

  it('throws (loudly, not a silent leak) if an org-scoped role is somehow signed with no organizationId', () => {
    const ctx = contextFor({ roles: [Role.ORG_ADMIN], organizationId: null });
    expect(() => factory.createForContext(ctx)).toThrow(/organizationId\/userId/);
  });
});
