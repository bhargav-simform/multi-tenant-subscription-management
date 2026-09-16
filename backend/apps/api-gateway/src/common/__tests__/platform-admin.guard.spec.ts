import { describe, it, expect } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Role } from '@app/common';
import type { JwtAccessPayload } from '@app/auth';
import { PlatformAdminGuard } from '../platform-admin.guard';

/**
 * §10.2's coarse authorisation. Note what is NOT asserted anywhere here: any
 * organisation, resource or subject of any kind. If a test for this guard ever needs
 * to construct a domain object, the guard has grown past §10.3 and the check belongs
 * downstream in CASL.
 */
describe('PlatformAdminGuard', () => {
  function contextFor(user?: Partial<JwtAccessPayload>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  it('allows a platform admin through', () => {
    const guard = new PlatformAdminGuard();
    expect(guard.canActivate(contextFor({ roles: [Role.PLATFORM_ADMIN] }))).toBe(true);
  });

  it('rejects an org admin with 403, not 404 (§25.2 — a role gate, not a lookup)', () => {
    const guard = new PlatformAdminGuard();
    expect(() => guard.canActivate(contextFor({ roles: [Role.ORG_ADMIN] }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects an org member', () => {
    const guard = new PlatformAdminGuard();
    expect(() => guard.canActivate(contextFor({ roles: [Role.ORG_MEMBER] }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects a caller with no roles claim at all rather than defaulting to allow', () => {
    const guard = new PlatformAdminGuard();
    expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });

  it('allows a platform admin holding additional roles', () => {
    const guard = new PlatformAdminGuard();
    expect(
      guard.canActivate(contextFor({ roles: [Role.ORG_MEMBER, Role.PLATFORM_ADMIN] })),
    ).toBe(true);
  });
});
