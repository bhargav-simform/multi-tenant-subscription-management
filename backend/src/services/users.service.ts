import { contextStore } from '../lib/context-store';
import { publish } from '../lib/events';
import { randomToken, sha256Hex } from '../lib/hashing';
import {
  ConflictException,
  GoneException,
  LastAdminException,
  NotFoundException,
  PlanLimitExceededException,
} from '../lib/http-errors';
import {
  runGlobal,
  transaction,
  transactionForOrganization,
  transactionWithDeferredScope,
} from '../lib/tenant-db';
import * as invitations from '../models/invitation.model';
import { InvitationAlreadyPendingError } from '../models/invitation.model';
import * as seats from '../models/subscription-seat.model';
import * as users from '../models/user.model';
import type { User, UserRole } from '../models/user.model';
import { EVENT_TYPES, TOPICS, type EventType } from '../types/events';
import * as credentials from './credentials.service';

const INVITATION_EXPIRY_DAYS = 7;
const INVITATION_GONE_MESSAGE = 'This invitation has expired or already been used.';

/*
 * The seat-limit mutations. Every path that changes used_seats locks the
 * subscription row first, inside one transaction with its own write, and publishes
 * only after commit.
 */

/** invite() never checked: a null org fails later, at the seat lock, with a 500. */
function organizationIdOf(): string {
  return contextStore.getOrThrow().organizationId as string;
}

/** The old tenant-scoped repositories threw (500) from a platform-admin context. */
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

async function publishUserEvent<T>(
  organizationId: string,
  eventType: EventType,
  payload: T,
): Promise<void> {
  await publish(TOPICS.USER, {
    eventType,
    organizationId,
    actorUserId: contextStore.get()?.userId ?? null,
    payload,
  });
}

/**
 * POST /users/invite. A pending invitation holds a seat, so used_seats is
 * incremented here, not at acceptance. The limit check reads used_seats under the
 * row lock; the user/invitation counts only feed the rejection message.
 */
export async function invite(dto: {
  email: string;
  role: UserRole;
}): Promise<{ invitationId: string; tokenForDev: string }> {
  const organizationId = organizationIdOf();

  const rawToken = randomToken();
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const invitationId = await transaction(async (tx) => {
    const seat = await seats.lockForUpdate(tx, organizationId);

    if (seat.usedSeats >= seat.maxSeatsSnapshot) {
      const [activeUsers, pendingInvitations] = await Promise.all([
        users.countActive(tx, organizationId),
        invitations.countPending(tx, organizationId),
      ]);
      throw new PlanLimitExceededException(
        {
          limitType: 'seats',
          limit: seat.maxSeatsSnapshot,
          current: seat.usedSeats,
          planCode: 'unknown', // plan metadata was never available on this path
          activeUsers,
          pendingInvitations,
        },
        `Your plan allows ${seat.maxSeatsSnapshot} seats. All ${seat.usedSeats} are held ` +
          `(${activeUsers} users, ${pendingInvitations} pending invitations). ` +
          `Remove a user or revoke a pending invitation before inviting another.`,
      );
    }

    let invitation;
    try {
      invitation = await invitations.create(tx, organizationId, {
        email: dto.email,
        role: dto.role,
        tokenHash,
        expiresAt,
      });
    } catch (err) {
      if (err instanceof InvitationAlreadyPendingError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
    await seats.adjustUsedSeats(tx, organizationId, 1);
    return invitation.id;
  });

  await publishUserEvent(organizationId, EVENT_TYPES.USER_INVITED, {
    invitationId,
    email: dto.email,
    role: dto.role,
  });

  // Email delivery is stubbed: the raw token is returned so the flow is demonstrable.
  return { invitationId, tokenForDev: rawToken };
}

/**
 * POST /invitations/:token/accept (public). Net-zero on used_seats — the invitation
 * already held the seat — but still takes the seat lock so the sweep cannot expire
 * the invitation mid-acceptance.
 *
 * Order: resolve the org via the SECURITY DEFINER function; a scoped, locked peek
 * for email and early expiry; create the credential OUTSIDE any transaction (never
 * hold the seat lock across it); then one transaction that re-validates under lock
 * and creates the user with the credential's userId. Here the invitation row is
 * locked before the subscription row — the one deliberate exception to lock
 * ordering, since the org is unknown until the invitation is found.
 *
 * Known gap (accepted): a revoke or second accept racing between the peek and the
 * final transaction 410s after the credential exists, orphaning it.
 */
export async function acceptInvitation(
  tokenRaw: string,
  dto: { firstName: string; lastName: string; password: string },
): Promise<User> {
  const tokenHash = sha256Hex(tokenRaw);

  const organizationId = await runGlobal((tx) =>
    invitations.findOrganizationIdByTokenHash(tx, tokenHash),
  );
  if (!organizationId) {
    throw new GoneException(INVITATION_GONE_MESSAGE);
  }

  const peeked = await transactionForOrganization(organizationId, (tx) =>
    invitations.findPendingByTokenHashForUpdate(tx, tokenHash),
  );
  if (!peeked || peeked.expiresAt.getTime() <= Date.now()) {
    throw new GoneException(INVITATION_GONE_MESSAGE);
  }

  let userId: string;
  try {
    ({ userId } = await credentials.createCredentials({
      organizationId,
      email: peeked.email,
      password: dto.password,
    }));
  } catch (err) {
    // This used to be an HTTP call to the auth service; any error response from it
    // (e.g. 409 for an email that already has a login) surfaced to the invitee as a
    // plain 500. Kept that way: rethrow as a non-HTTP error.
    throw new Error(
      `Credential creation failed during invitation acceptance: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const result = await transactionWithDeferredScope(async (tx, scope) => {
    await scope(organizationId);

    const invitation = await invitations.findPendingByTokenHashForUpdate(tx, tokenHash);
    if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
      throw new GoneException(INVITATION_GONE_MESSAGE);
    }

    await seats.lockForUpdate(tx, organizationId);

    const created = await users.create(tx, {
      id: userId,
      organizationId,
      email: invitation.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      role: invitation.role,
    });
    await invitations.markAccepted(tx, invitation.id);
    // used_seats unchanged: the seat was already held by the invitation.

    return { user: created, invitationId: invitation.id, organizationId };
  });

  await publishUserEvent(result.organizationId, EVENT_TYPES.USER_CREATED, {
    userId: result.user.id,
    email: result.user.email,
  });
  await publishUserEvent(result.organizationId, EVENT_TYPES.INVITATION_ACCEPTED, {
    invitationId: result.invitationId,
  });

  return result.user;
}

/** DELETE /invitations/:id. Releases the invitation's seat. */
export async function revokeInvitation(invitationId: string): Promise<void> {
  const organizationId = requireOrganizationId();

  await transaction(async (tx) => {
    const invitation = await invitations.findById(tx, organizationId, invitationId);
    if (!invitation || invitation.acceptedAt || invitation.revokedAt) {
      throw new NotFoundException();
    }
    await seats.lockForUpdate(tx, organizationId);
    await invitations.markRevoked(tx, organizationId, invitationId);
    await seats.adjustUsedSeats(tx, organizationId, -1);
  });

  await publishUserEvent(organizationId, EVENT_TYPES.INVITATION_REVOKED, { invitationId });
}

/** PATCH /users/:id/role. The last active admin cannot be demoted. */
export async function updateRole(userId: string, role: UserRole): Promise<User> {
  const organizationId = requireOrganizationId();

  const updated = await transaction(async (tx) => {
    const user = await users.findById(tx, organizationId, userId);
    if (!user) throw new NotFoundException();

    if (user.role === 'org_admin' && role !== 'org_admin') {
      const adminCount = await users.countActiveAdmins(tx, organizationId);
      if (adminCount <= 1) {
        throw new LastAdminException();
      }
    }

    await users.updateRole(tx, organizationId, userId, role);
    return users.findById(tx, organizationId, userId);
  });

  await publishUserEvent(organizationId, EVENT_TYPES.USER_ROLE_CHANGED, { userId, role });
  return updated as User;
}

/** DELETE /users/:id. Soft-removes the user and frees their seat; not the last admin. */
export async function removeUser(userId: string): Promise<void> {
  const organizationId = requireOrganizationId();

  await transaction(async (tx) => {
    const user = await users.findById(tx, organizationId, userId);
    if (!user || user.status === 'removed') {
      throw new NotFoundException();
    }

    if (user.role === 'org_admin') {
      const adminCount = await users.countActiveAdmins(tx, organizationId);
      if (adminCount <= 1) {
        throw new LastAdminException();
      }
    }

    await seats.lockForUpdate(tx, organizationId);
    await users.markRemoved(tx, organizationId, userId);
    await seats.adjustUsedSeats(tx, organizationId, -1);
  });

  await publishUserEvent(organizationId, EVENT_TYPES.USER_REMOVED, { userId });
}
