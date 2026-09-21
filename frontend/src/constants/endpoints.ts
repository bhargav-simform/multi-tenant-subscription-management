/**
 * Every route the api-gateway exposes. The gateway is the ONLY backend the SPA
 * ever talks to — the other six services are on an internal bridge network with
 * no published port at all.
 *
 * Note what is absent, and deliberately so (ARCHITECTURE §13.3): no endpoint
 * takes an organisation id. "My organisation" is decided entirely by the signed
 * context minted from the caller's token; there is no parameter through which a
 * client could name a different one. The single exception is the platform-admin
 * ORGANIZATIONS.DETAIL route, which returns metadata only, never content.
 */
export const ENDPOINTS = {
    AUTH: {
        LOGIN: '/auth/login',
        REFRESH: '/auth/refresh',
        LOGOUT: '/auth/logout',
    },
    ONBOARDING: {
        SIGNUP: '/onboarding/signup',
    },
    INVITATIONS: {
        /** Public — the invitation token IS the credential. */
        ACCEPT: (token: string) => `/invitations/${encodeURIComponent(token)}/accept`,
        /** Pending invitations for the caller's org, for the Users page's merged view. */
        LIST: '/invitations',
        /** Authenticated org admin revoking a pending invite, by invitation id. */
        REVOKE: (id: string) => `/invitations/${encodeURIComponent(id)}`,
    },
    USERS: {
        LIST: '/users',
        INVITE: '/users/invite',
        DETAIL: (id: string) => `/users/${encodeURIComponent(id)}`,
        ROLE: (id: string) => `/users/${encodeURIComponent(id)}/role`,
    },
    ORGANIZATIONS: {
        /** Any authenticated role — the caller's own organisation. */
        ME: '/organizations/me',
        /** Platform admin only. */
        LIST: '/organizations',
        /** Platform admin only — metadata, never content. */
        DETAIL: (id: string) => `/organizations/${encodeURIComponent(id)}`,
    },
    SUBSCRIPTIONS: {
        PLANS: '/plans',
        CURRENT: '/subscriptions/current',
        CHANGE: '/subscriptions/change',
        /** Platform admin only — aggregate counts across organisations. */
        USAGE: '/usage',
    },
    RESOURCES: {
        LIST: '/resources',
        CREATE: '/resources',
        DETAIL: (id: string) => `/resources/${encodeURIComponent(id)}`,
    },
    AUDIT: {
        LIST: '/audit',
        /** Platform admin only. */
        SECURITY: '/audit/security',
    },
    DASHBOARD: {
        /** The one aggregate route in the gateway — saves the SPA a waterfall. */
        ROOT: '/dashboard',
    },
} as const;
