import { Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';

import { PageLoadingState } from '@/components/common/page-state';
import {
    OrgAdminRoute,
    PlatformAdminRoute,
    PublicOnlyRoute,
    TenantRoute,
} from '@/components/common/protected-route';
import { ROUTES } from '@/constants/routes';

import * as Pages from './lazyPages';

const suspense = (node: ReactNode) => <Suspense fallback={<PageLoadingState className="h-screen" />}>{node}</Suspense>;

/**
 * Two route trees that share no page module.
 *
 * The tenant tree mounts content features. The platform-admin tree mounts only
 * metadata pages. They meet at the router and nowhere else — which is what makes
 * "a platform admin cannot reach organisation content" a property of the build
 * rather than a rule someone has to keep remembering.
 *
 * Each guard is mirrored by a server-side check. The guards decide what renders;
 * the gateway, CASL and RLS decide what is allowed.
 */
export const router = createBrowserRouter([
    {
        element: <PublicOnlyRoute />,
        children: [
            { path: ROUTES.LOGIN, element: suspense(<Pages.LoginPage />) },
            { path: ROUTES.SIGNUP, element: suspense(<Pages.SignupPage />) },
        ],
    },

    // The invitee has no session, and may well already be signed in as someone
    // else in another tab — so this route is outside PublicOnlyRoute.
    { path: ROUTES.ACCEPT_INVITE, element: suspense(<Pages.AcceptInvitePage />) },

    // ── Tenant shell ────────────────────────────────────────────────────────
    {
        element: <TenantRoute />,
        children: [
            {
                element: suspense(<Pages.TenantLayout />),
                children: [
                    { path: ROUTES.DASHBOARD, element: suspense(<Pages.DashboardPage />) },
                    { path: ROUTES.RESOURCES, element: suspense(<Pages.ResourcesPage />) },
                    { path: ROUTES.RESOURCE_DETAIL, element: suspense(<Pages.ResourceDetailPage />) },
                    { path: ROUTES.AUDIT, element: suspense(<Pages.AuditPage />) },
                    {
                        // Managing users and changing the plan are org-admin actions.
                        element: <OrgAdminRoute />,
                        children: [
                            { path: ROUTES.USERS, element: suspense(<Pages.UsersPage />) },
                            { path: ROUTES.PLAN, element: suspense(<Pages.PlanPage />) },
                        ],
                    },
                ],
            },
        ],
    },

    // ── Platform-admin shell ────────────────────────────────────────────────
    {
        element: <PlatformAdminRoute />,
        children: [
            {
                element: suspense(<Pages.AdminLayout />),
                children: [
                    { path: ROUTES.ADMIN, element: <Navigate to={ROUTES.ADMIN_ORGANIZATIONS} replace /> },
                    { path: ROUTES.ADMIN_ORGANIZATIONS, element: suspense(<Pages.AdminOrganizationsPage />) },
                    { path: ROUTES.ADMIN_ORGANIZATION_DETAIL, element: suspense(<Pages.AdminOrganizationDetailPage />) },
                    { path: ROUTES.ADMIN_SECURITY, element: suspense(<Pages.AdminSecurityPage />) },
                ],
            },
        ],
    },

    { path: ROUTES.UNAUTHORIZED, element: suspense(<Pages.UnauthorizedPage />) },
    { path: '/', element: <Navigate to={ROUTES.DASHBOARD} replace /> },
    { path: '*', element: suspense(<Pages.NotFoundPage />) },
]);
