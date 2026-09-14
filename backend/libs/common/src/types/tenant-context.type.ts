import { Role } from '../constants/roles.enum';

/**
 * The context minted by api-gateway and signed into x-internal-context (§9.4, §13.3).
 * organizationId is null ONLY for platform admins (§11.3) — this is what makes every
 * RLS policy evaluate false for them (§13.6). It is never read from anywhere else:
 * not a request body, not a query param, not a path segment.
 *
 * userId is null ONLY for the anonymous context signed for the three @Public()
 * gateway routes (§9.4 "Anonymous context") — there is no authenticated identity
 * yet for /auth/login, /auth/refresh, /onboarding/signup or
 * /invitations/:token/accept. roles is always [] in that case. A handler for one
 * of those routes must not assume userId/organizationId are present.
 */
export interface TenantContextPayload {
  userId: string | null;
  organizationId: string | null;
  roles: Role[];
  correlationId: string;
  iat: number;
  exp: number;
}

/** What InternalContextGuard verifies before anything downstream runs. */
export interface SignedInternalContext {
  payload: TenantContextPayload;
  signature: string;
}
