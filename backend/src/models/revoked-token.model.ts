import type { Tx } from '../lib/tenant-db';

/**
 * revoked_access_tokens — the logout denylist (formerly Redis `platform:denylist:<jti>`).
 * A registry table with no RLS: a jti is not tenant data.
 */
export async function isRevoked(db: Tx, jti: string, now: Date): Promise<boolean> {
  const row = await db.revokedAccessToken.findFirst({
    where: { jti, expiresAt: { gt: now } },
    select: { jti: true },
  });
  return row !== null;
}

export async function revoke(db: Tx, jti: string, expiresAt: Date): Promise<void> {
  await db.revokedAccessToken.upsert({
    where: { jti },
    create: { jti, expiresAt },
    update: { expiresAt },
  });
}

export async function deleteExpired(db: Tx, now: Date): Promise<number> {
  const { count } = await db.revokedAccessToken.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}
