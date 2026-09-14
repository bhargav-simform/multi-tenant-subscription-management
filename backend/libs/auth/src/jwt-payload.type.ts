import type { Role } from '@app/common';

/**
 * The access token payload (§11.2, §11.4). organizationId is null only for
 * platform admins (§11.3) — the JWT carries no other tenant-identifying field,
 * and jti enables the Redis denylist for immediate logout (§16.2).
 */
export interface JwtAccessPayload {
  sub: string; // userId
  organizationId: string | null;
  roles: Role[];
  jti: string;
  iat: number;
  exp: number;
}

/**
 * The refresh token payload (§11.4). Deliberately narrow — no organizationId, no
 * roles — so a stolen refresh token cannot assert a tenant on its own; it can only
 * be exchanged for a fresh access token via auth-service, which re-derives both
 * from the credentials row.
 */
export interface JwtRefreshPayload {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}
