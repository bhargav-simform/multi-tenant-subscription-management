import type { NextFunction, Request, Response } from 'express';
import { createAbilityForContext } from '../lib/casl';
import { contextStore } from '../lib/context-store';
import { ForbiddenException } from '../lib/http-errors';
import { Role, type Action, type Subject } from '../types/constants';

/**
 * Throws the 403 a failed ability check has always produced. Checks the subject TYPE
 * only; row-level rules (e.g. "members may delete only their own resources") live in
 * the service, where the row exists.
 */
export function assertCan(action: Action, subject: Subject): void {
  const ability = createAbilityForContext(contextStore.getOrThrow());
  if (!ability.can(action, subject)) {
    throw new ForbiddenException(`You do not have permission to ${action} ${subject}`);
  }
}

/** Route-level CASL check — the Express equivalent of @CheckAbility(action, subject). */
export function authorize(action: Action, subject: Subject) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    assertCan(action, subject);
    next();
  };
}

/**
 * Coarse gate for the platform-admin-only routes (/organizations, /organizations/:id,
 * /usage), checked before anything else on those routes.
 */
export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user?.roles?.includes(Role.PLATFORM_ADMIN)) {
    throw new ForbiddenException('This route is restricted to platform administrators');
  }
  next();
}
