import type { Invitation as PrismaInvitation, UserRole } from '../generated/prisma/client';
import { isUniqueViolation } from '../lib/db-errors';
import type { Tx } from '../lib/tenant-db';

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: UserRole;
  tokenHash: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Thrown by create() when the org already has a pending invitation for that email. */
export class InvitationAlreadyPendingError extends Error {
  constructor(email: string) {
    super(`An invitation for "${email}" is already pending in this organization`);
    this.name = 'InvitationAlreadyPendingError';
  }
}

export function toInvitation(row: PrismaInvitation): Invitation {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** Pending = unaccepted, unrevoked and unexpired. Only these hold a seat. */
function pendingWhere(organizationId: string) {
  return {
    organizationId,
    acceptedAt: null,
    revokedAt: null,
    expiresAt: { gt: new Date() },
    deletedAt: null,
  };
}

export async function countPending(db: Tx, organizationId: string): Promise<number> {
  return db.invitation.count({ where: pendingWhere(organizationId) });
}

export async function listPending(db: Tx, organizationId: string): Promise<Invitation[]> {
  const rows = await db.invitation.findMany({
    where: pendingWhere(organizationId),
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toInvitation);
}

/**
 * No check-then-insert: the partial unique index uq_invitations_org_email_pending is
 * the guarantee, and its violation becomes InvitationAlreadyPendingError.
 */
export async function create(
  db: Tx,
  organizationId: string,
  data: { email: string; role: UserRole; tokenHash: string; expiresAt: Date },
): Promise<Invitation> {
  try {
    return toInvitation(await db.invitation.create({ data: { ...data, organizationId } }));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new InvitationAlreadyPendingError(data.email);
    }
    throw err;
  }
}

/**
 * Locked FOR UPDATE so acceptance and the expiry sweep cannot race on one
 * invitation. Does not check expiry — callers do.
 */
export async function findPendingByTokenHashForUpdate(
  db: Tx,
  tokenHash: string,
): Promise<Invitation | null> {
  const locked = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM invitations
    WHERE token_hash = ${tokenHash} AND accepted_at IS NULL AND revoked_at IS NULL AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (locked.length === 0) return null;
  const row = await db.invitation.findUnique({ where: { id: locked[0].id } });
  return row ? toInvitation(row) : null;
}

export async function markAccepted(db: Tx, id: string): Promise<void> {
  await db.invitation.updateMany({ where: { id }, data: { acceptedAt: new Date() } });
}

export async function findById(
  db: Tx,
  organizationId: string,
  id: string,
): Promise<Invitation | null> {
  const row = await db.invitation.findFirst({ where: { id, organizationId, deletedAt: null } });
  return row ? toInvitation(row) : null;
}

export async function markRevoked(db: Tx, organizationId: string, id: string): Promise<void> {
  await db.invitation.updateMany({
    where: { id, organizationId },
    data: { revokedAt: new Date() },
  });
}

/** The sweep's target set: pending but past expiry. */
export async function findExpiredIds(db: Tx, organizationId: string): Promise<string[]> {
  const rows = await db.invitation.findMany({
    select: { id: true },
    where: {
      organizationId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { lte: new Date() },
      deletedAt: null,
    },
  });
  return rows.map((r) => r.id);
}

/** Expiry is recorded via revoked_at, like an admin revoke; the event says which. */
export async function markManyExpired(db: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.invitation.updateMany({ where: { id: { in: ids } }, data: { revokedAt: new Date() } });
}

/**
 * SECURITY DEFINER lookup: the org a token hash belongs to, and nothing else. An
 * unscoped query on invitations returns zero rows under RLS, so acceptance must
 * resolve its org this way first.
 */
export async function findOrganizationIdByTokenHash(
  db: Tx,
  tokenHash: string,
): Promise<string | null> {
  const rows = await db.$queryRaw<{ get_invitation_organization_id: string | null }[]>`
    SELECT get_invitation_organization_id(${tokenHash}::varchar)
  `;
  return rows[0]?.get_invitation_organization_id ?? null;
}
