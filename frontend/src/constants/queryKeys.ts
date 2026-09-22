/**
 * Every query key in the app.
 *
 * KEYS ARE TENANT-AGNOSTIC, and that is a deliberate architectural property, not
 * an oversight: the tenant is implicit in the access token, so an organisation id
 * must never appear in a key. If it did, the cache would imply the client chooses
 * its own tenant — exactly the assumption the backend's RLS design removes. On a
 * user switch the whole cache is cleared instead (see AuthContext).
 */
export const QUERY_KEYS = {
    AUTH: {
        SESSION: ['auth', 'session'] as const,
    },
    DASHBOARD: {
        ROOT: ['dashboard'] as const,
    },
    ORGANIZATION: {
        ME: ['organization', 'me'] as const,
    },
    USERS: {
        ALL: ['users'] as const,
        LIST: (cursor?: string, limit?: number) => ['users', 'list', { cursor, limit }] as const,
        DETAIL: (id: string) => ['users', 'detail', id] as const,
        INVITATIONS: ['users', 'invitations'] as const,
    },
    RESOURCES: {
        ALL: ['resources'] as const,
        LIST: (cursor?: string, limit?: number, sort?: string, hasDescription?: string) =>
            ['resources', 'list', { cursor, limit, sort, hasDescription }] as const,
        DETAIL: (id: string) => ['resources', 'detail', id] as const,
    },
    SUBSCRIPTION: {
        ALL: ['subscription'] as const,
        CURRENT: ['subscription', 'current'] as const,
        PLANS: ['subscription', 'plans'] as const,
    },
    AUDIT: {
        ALL: ['audit'] as const,
        LIST: (cursor?: string, limit?: number, eventType?: string) =>
            ['audit', 'list', { cursor, limit, eventType }] as const,
        SECURITY: (cursor?: string, limit?: number) => ['audit', 'security', { cursor, limit }] as const,
    },
    ADMIN: {
        ALL: ['admin'] as const,
        ORGANIZATIONS: (cursor?: string, limit?: number) => ['admin', 'organizations', { cursor, limit }] as const,
        ORGANIZATION_DETAIL: (id: string) => ['admin', 'organizations', 'detail', id] as const,
        USAGE: (organizationId?: string) => ['admin', 'usage', { organizationId }] as const,
    },
} as const;
