import { contextStore } from '../lib/context-store';
import { publish } from '../lib/events';
import { NotFoundException } from '../lib/http-errors';
import { createLogger } from '../lib/logger';
import { runGlobal, transaction, transactionForOrganization } from '../lib/tenant-db';
import * as invitations from '../models/invitation.model';
import type { Invitation } from '../models/invitation.model';
import * as users from '../models/user.model';
import type { User } from '../models/user.model';
import { EVENT_TYPES, TOPICS } from '../types/events';
import type { CursorPage } from '../types/pagination';
import { toUserResponse, type UserResponse } from '../views/user.view';

const logger = createLogger('UsersReadService');

/** The caller's org. A context without one (platform admin) reaching here is a bug — 500. */
function requireOrganizationId(): string {
  const organizationId = contextStore.getOrThrow().organizationId;
  if (organizationId === null) {
    throw new Error(
      'Tenant-scoped user query used from a platform-admin context (organizationId is null). ' +
        'Platform admins must not read tenant content.',
    );
  }
  return organizationId;
}

/** GET /users (and the dashboard's recent-users card). Non-removed users, newest first. */
export async function listPage(query: {
  cursor?: string;
  limit?: number;
}): Promise<CursorPage<UserResponse>> {
  const page = await transaction((tx) => users.listPage(tx, requireOrganizationId(), query));
  return { ...page, items: page.items.map(toUserResponse) };
}

/** Unpaginated: bounded by the org's seat limit. */
export async function listPendingInvitations(): Promise<Invitation[]> {
  const organizationId = contextStore.getOrThrow().organizationId;
  // A null org (unreachable past authorize) simply sees nothing under RLS.
  return transaction(async (tx) =>
    organizationId === null ? [] : invitations.listPending(tx, organizationId),
  );
}

/**
 * A foreign-tenant id 404s exactly like a missing one (RLS hides it). The miss is
 * then probed for the security event only — never for the caller.
 */
export async function getById(id: string): Promise<User> {
  const user = await transaction((tx) => users.findById(tx, requireOrganizationId(), id));
  if (!user) {
    await reportIfCrossTenantAttempt(id);
    throw new NotFoundException();
  }
  return user;
}

/**
 * Publishes CrossTenantAccessAttempted when the id exists in some other org. The
 * probe returns a boolean only, so the owning org never enters this process.
 * Best-effort: a probe failure must not change the 404.
 */
async function reportIfCrossTenantAttempt(userId: string): Promise<void> {
  try {
    const ctx = contextStore.getOrThrow();
    const existsElsewhere = await runGlobal((tx) => users.existsInAnyOrganization(tx, userId));
    if (!existsElsewhere) return;

    await publish(TOPICS.SECURITY, {
      eventType: EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      payload: {
        subjectType: 'User',
        subjectId: userId,
        actorOrganizationId: ctx.organizationId,
        actorUserId: ctx.userId,
      },
    });
  } catch (err) {
    logger.error(
      `Cross-tenant detection probe failed for user ${userId}: ${(err as Error).message}`,
    );
  }
}

/**
 * The role lookup at login/refresh, before any tenant context exists: resolve the
 * user's org via the SECURITY DEFINER function, then read the role scoped to it.
 */
export async function getRoleForAuthService(
  userId: string,
): Promise<{ role: 'org_admin' | 'org_member' | null }> {
  const organizationId = await runGlobal((tx) => users.findOrganizationIdForUser(tx, userId));
  if (!organizationId) return { role: null };
  const role = await transactionForOrganization(organizationId, (tx) =>
    users.findNonRemovedRole(tx, userId),
  );
  return { role };
}
