import { Role } from '../constants/roles.enum';

/**
 * The context minted by api-gateway and signed into x-internal-context (§9.4, §13.3).
 * organizationId is null ONLY for platform admins (§11.3) — this is what makes every
 * RLS policy evaluate false for them (§13.6). It is never read from anywhere else:
 * not a request body, not a query param, not a path segment.
 */
export interface TenantContextPayload {
  userId: string;
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
