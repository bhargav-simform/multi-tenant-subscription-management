/**
 * Two route trees that never meet.
 *
 * TENANT routes are for org admins and org members and mount content features.
 * ADMIN routes are for platform admins and mount NOTHING that touches tenant
 * content — mirroring the backend's structural separation (§13.6) so a content
 * component cannot be dropped onto an admin page by accident.
 */
export const ROUTES = {
    // Public
    LOGIN: '/login',
    SIGNUP: '/signup',
    ACCEPT_INVITE: '/invite/:token',

    // Tenant (org admin + org member)
    DASHBOARD: '/dashboard',
    RESOURCES: '/resources',
    RESOURCE_DETAIL: '/resources/:id',
    USERS: '/users',
    PLAN: '/plan',
    AUDIT: '/audit',

    // Platform admin — metadata only
    ADMIN: '/admin',
    ADMIN_ORGANIZATIONS: '/admin/organizations',
    ADMIN_ORGANIZATION_DETAIL: '/admin/organizations/:id',
    ADMIN_SECURITY: '/admin/security',

    // Misc
    UNAUTHORIZED: '/unauthorized',
    NOT_FOUND: '/404',
} as const;

export const buildRoute = {
    resourceDetail: (id: string) => `/resources/${id}`,
    acceptInvite: (token: string) => `/invite/${token}`,
    adminOrganizationDetail: (id: string) => `/admin/organizations/${id}`,
};
