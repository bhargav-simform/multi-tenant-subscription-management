import { getPrisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';
import * as revokedTokens from '../models/revoked-token.model';

const logger = createLogger('TokenDenylist');

/**
 * Immediate logout: an access token's jti is denylisted until the token's own expiry,
 * otherwise a logged-out token stays valid for the rest of its 15 minutes.
 */

/**
 * Fails CLOSED: if the lookup errors, the token is treated as revoked. Better every
 * request 401s during a database outage than a logged-out token keeps working.
 */
export async function isDenied(jti: string): Promise<boolean> {
  try {
    return await revokedTokens.isRevoked(getPrisma(), jti, new Date());
  } catch (err) {
    logger.error(`Denylist check failed, failing closed: ${(err as Error).message}`);
    return true;
  }
}

export async function deny(jti: string, ttlSeconds: number): Promise<void> {
  await revokedTokens.revoke(getPrisma(), jti, new Date(Date.now() + ttlSeconds * 1000));
}

/** Hourly housekeeping (jobs/denylist-cleanup.ts) — what Redis TTL expiry did for free. */
export async function purgeExpired(): Promise<number> {
  return revokedTokens.deleteExpired(getPrisma(), new Date());
}
