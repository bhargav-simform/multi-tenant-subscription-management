import { randomUUID } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { randomToken, sha256Hex } from '../lib/hashing';
import type { Tx } from '../lib/tenant-db';
import * as refreshTokens from '../models/refresh-token.model';
import type { Role } from '../types/constants';
import type { JwtAccessPayload } from '../types/tenant-context';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * What goes into the access token. `userId` (the `sub` claim) is the domain user's
 * id — distinct from a credentialId, which is what refresh_tokens references.
 * Confusing the two would point a refresh token at the wrong row.
 */
export interface TokenPrincipal {
  userId: string;
  organizationId: string | null;
  roles: Role[];
}

/** A fresh access + refresh pair for a new session (login). */
export async function issue(
  db: Tx,
  credentialId: string,
  principal: TokenPrincipal,
): Promise<IssuedTokens> {
  const accessToken = signAccessToken(principal);
  const { raw, hash } = generateOpaqueToken();
  await refreshTokens.create(db, { credentialId, tokenHash: hash, expiresAt: refreshExpiryDate() });
  return { accessToken, refreshToken: raw };
}

/**
 * Rotation: a new pair, and the PRESENTED token marked replaced by the new one. The
 * caller has already checked the presented token is valid, unexpired and unrevoked.
 */
export async function rotate(
  db: Tx,
  presentedToken: { id: string; credentialId: string },
  principal: TokenPrincipal,
): Promise<IssuedTokens> {
  const accessToken = signAccessToken(principal);
  const { raw, hash } = generateOpaqueToken();
  const newToken = await refreshTokens.create(db, {
    credentialId: presentedToken.credentialId,
    tokenHash: hash,
    expiresAt: refreshExpiryDate(),
  });
  await refreshTokens.markReplaced(db, presentedToken.id, newToken.id);
  return { accessToken, refreshToken: raw };
}

function signAccessToken(principal: TokenPrincipal): string {
  const payload: Omit<JwtAccessPayload, 'iat' | 'exp'> = {
    sub: principal.userId,
    organizationId: principal.organizationId,
    roles: principal.roles,
    jti: randomUUID(),
  };
  return jwt.sign(payload, env.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: env.jwtAccessExpiresIn as SignOptions['expiresIn'],
  });
}

/** Only the hash is ever stored, so a database read alone never yields a usable token. */
function generateOpaqueToken(): { raw: string; hash: string } {
  const raw = randomToken();
  return { raw, hash: sha256Hex(raw) };
}

function refreshExpiryDate(): Date {
  return new Date(Date.now() + parseDays(env.jwtRefreshExpiresIn) * MS_PER_DAY);
}

/** Only "<n>d" is understood; anything else silently means 7 days (unchanged quirk). */
function parseDays(expr: string): number {
  const match = /^(\d+)d$/.exec(expr);
  return match ? Number(match[1]) : 7;
}
