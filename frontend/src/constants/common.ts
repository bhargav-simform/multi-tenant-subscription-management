/** Role strings exactly as user-service's UserRole enum emits them. */
export const USER_ROLE = {
    ORG_ADMIN: 'org_admin',
    ORG_MEMBER: 'org_member',
} as const;

/**
 * A platform admin is NOT a row in the users table with a special role — it is a
 * credentials row whose organizationId is NULL, which is the single column that
 * makes AuthService.resolveRoles return PLATFORM_ADMIN. The SPA therefore derives
 * it the same way the backend does, from the login response, never from a string
 * it invented locally.
 */
export const PLATFORM_ADMIN_ROLE = 'platform_admin';

export const STALE_TIME = {
    THIRTY_SECONDS: 30 * 1000,
    ONE_MINUTE: 60 * 1000,
    THREE_MINUTES: 3 * 60 * 1000,
    FIVE_MINUTES: 5 * 60 * 1000,
    /** The plan catalogue is global and effectively immutable. */
    ONE_HOUR: 60 * 60 * 1000,
} as const;

export const QUERY_META = {
    /** Queries that handle (or intentionally ignore) their own failures. */
    SUPPRESS_ERROR_TOAST: 'suppressErrorToast',
} as const;

/** Server-side keyset pagination. The gateway caps limit at 100. */
export const PAGE_SIZE = {
    DEFAULT: 25,
    MAX: 100,
} as const;

export const USER_STATUS = {
    ACTIVE: 'active',
    INVITED: 'invited',
    SUSPENDED: 'suspended',
} as const;

export const ORGANIZATION_STATUS = {
    ACTIVE: 'active',
    SUSPENDED: 'suspended',
} as const;
