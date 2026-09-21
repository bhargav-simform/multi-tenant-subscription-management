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

/**
 * Exactly as audit-service's EVENT_TYPES emits them (backend/libs/common/src/events/event-types.ts) —
 * the four CONTENT topics only (organization, user, subscription, resource). The two SECURITY
 * event types (CrossTenantAccessAttempted, AuthenticationFailed) are deliberately excluded: they
 * land on the separate platform-admin security page, never on this org-facing audit log.
 */
export const AUDIT_EVENT_TYPE = {
    ORGANIZATION_CREATED: 'OrganizationCreated',
    ORGANIZATION_PROVISIONED: 'OrganizationProvisioned',
    ONBOARDING_FAILED: 'OnboardingFailed',
    ORGANIZATION_SUSPENDED: 'OrganizationSuspended',
    USER_CREDENTIALS_CREATED: 'UserCredentialsCreated',
    USER_INVITED: 'UserInvited',
    USER_CREATED: 'UserCreated',
    USER_REMOVED: 'UserRemoved',
    USER_ROLE_CHANGED: 'UserRoleChanged',
    INVITATION_ACCEPTED: 'InvitationAccepted',
    INVITATION_REVOKED: 'InvitationRevoked',
    INVITATION_EXPIRED: 'InvitationExpired',
    SUBSCRIPTION_ASSIGNED: 'SubscriptionAssigned',
    SUBSCRIPTION_CHANGED: 'SubscriptionChanged',
    USAGE_UPDATED: 'UsageUpdated',
    PLAN_LIMIT_EXCEEDED: 'PlanLimitExceeded',
    RESOURCE_CREATED: 'ResourceCreated',
    RESOURCE_DELETED: 'ResourceDeleted',
} as const;
