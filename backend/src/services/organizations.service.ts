import { contextStore } from '../lib/context-store';
import { ForbiddenException, NotFoundException } from '../lib/http-errors';
import { getPrisma } from '../lib/prisma';
import * as organizations from '../models/organization.model';
import type { Organization } from '../models/organization.model';
import type { CursorPage } from '../types/pagination';

/**
 * The organisation is NEVER named by the caller — only by the token's
 * organizationId. A platform admin has no "my organisation": 404, not an empty result.
 */
export async function getMyOrganization(): Promise<Organization> {
  const ctx = contextStore.getOrThrow();
  if (!ctx.organizationId) {
    throw new NotFoundException();
  }
  const org = await organizations.findById(getPrisma(), ctx.organizationId);
  if (!org) throw new NotFoundException();
  return org;
}

/**
 * Platform admin ONLY. organizations has no RLS (it is the registry), so there is no
 * database backstop, and CASL's type-level READ Organization check cannot express
 * "only your own" without a loaded row. This explicit check IS the enforcement.
 */
export async function listOrganizations(query: {
  cursor?: string;
  limit?: number;
}): Promise<CursorPage<Organization>> {
  requirePlatformAdmin();
  return organizations.listPage(getPrisma(), query);
}

/** Same rule as listOrganizations; defence in depth against a careless future route. */
export async function getOrganizationById(id: string): Promise<Organization> {
  requirePlatformAdmin();
  const org = await organizations.findById(getPrisma(), id);
  if (!org) throw new NotFoundException();
  return org;
}

function requirePlatformAdmin(): void {
  if (!contextStore.isPlatformAdmin()) {
    throw new ForbiddenException('Platform admin access required');
  }
}
