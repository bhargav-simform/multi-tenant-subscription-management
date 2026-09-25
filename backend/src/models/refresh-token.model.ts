import type { RefreshToken as PrismaRefreshToken } from '../generated/prisma/client';
import type { Tx } from '../lib/tenant-db';

/**
 * refresh_tokens — single-use rotation. Only the sha256 of the raw token is stored.
 * `replacedBy` chains a token to its successor; presenting a revoked one is theft.
 */
export interface RefreshToken {
  id: string;
  credentialId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
  createdAt: Date;
}

function toRefreshToken(row: PrismaRefreshToken): RefreshToken {
  return {
    id: row.id,
    credentialId: row.credentialId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    replacedBy: row.replacedBy,
    createdAt: row.createdAt,
  };
}

export async function findByTokenHash(db: Tx, tokenHash: string): Promise<RefreshToken | null> {
  const row = await db.refreshToken.findUnique({ where: { tokenHash } });
  return row ? toRefreshToken(row) : null;
}

export async function create(
  db: Tx,
  data: { credentialId: string; tokenHash: string; expiresAt: Date },
): Promise<RefreshToken> {
  return toRefreshToken(await db.refreshToken.create({ data }));
}

/** Marks the presented token as rotated away in favour of its successor. */
export async function markReplaced(db: Tx, id: string, replacedById: string): Promise<void> {
  await db.refreshToken.updateMany({
    where: { id },
    data: { replacedBy: replacedById, revokedAt: new Date() },
  });
}

/** Reuse detected: every still-live token of this credential is now suspect. */
export async function revokeAllForCredential(db: Tx, credentialId: string): Promise<void> {
  await db.refreshToken.updateMany({
    where: { credentialId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revoke(db: Tx, id: string): Promise<void> {
  await db.refreshToken.updateMany({ where: { id }, data: { revokedAt: new Date() } });
}
