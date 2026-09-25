import type { Role } from './constants';

/**
 * Per-request identity, held in AsyncLocalStorage (lib/context-store.ts).
 *
 * organizationId is null ONLY for platform admins. userId is null ONLY for the
 * anonymous context of the four public routes (login, refresh, signup, accept
 * invitation) — roles is always [] then. Neither is ever read from a request body,
 * query param or path segment; only from the verified JWT.
 */
export interface TenantContextPayload {
  userId: string | null;
  organizationId: string | null;
  roles: Role[];
  correlationId: string;
  iat: number;
  exp: number;
}

/** The access token payload. jti keys the logout denylist. */
export interface JwtAccessPayload {
  sub: string;
  organizationId: string | null;
  roles: Role[];
  jti: string;
  iat: number;
  exp: number;
}
