import { createHash, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';

/** Argon2id with the parameters the auth service has always used. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** A verify that throws (malformed hash) counts as a mismatch. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** sha256 hex — how refresh tokens and invitation tokens are stored (never raw). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** An opaque random token: two v4 UUIDs concatenated (~244 bits of randomness). */
export function randomToken(): string {
  return randomUUID() + randomUUID();
}
