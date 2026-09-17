import { lazy } from 'react';

/**
 * Route-level code splitting.
 *
 * The admin pages are split from the tenant pages here as well as in the module
 * graph: a tenant user never downloads the admin bundle, and vice versa.
 */

// Public
export const LoginPage = lazy(() => import('@/pages/login/LoginPage'));
export const SignupPage = lazy(() => import('@/pages/signup/SignupPage'));
export const AcceptInvitePage = lazy(() => import('@/pages/accept-invite/AcceptInvitePage'));

// Shells
export const TenantLayout = lazy(() => import('@/layouts/TenantLayout'));
export const AdminLayout = lazy(() => import('@/layouts/AdminLayout'));

// Tenant
export const DashboardPage = lazy(() => import('@/pages/dashboard/DashboardPage'));
export const ResourcesPage = lazy(() => import('@/pages/resources/ResourcesPage'));
export const ResourceDetailPage = lazy(() => import('@/pages/resources/ResourceDetailPage'));
export const UsersPage = lazy(() => import('@/pages/users/UsersPage'));
export const PlanPage = lazy(() => import('@/pages/plan/PlanPage'));
export const AuditPage = lazy(() => import('@/pages/audit/AuditPage'));

// Platform admin
export const AdminOrganizationsPage = lazy(() => import('@/pages/admin/AdminOrganizationsPage'));
export const AdminOrganizationDetailPage = lazy(() => import('@/pages/admin/AdminOrganizationDetailPage'));
export const AdminSecurityPage = lazy(() => import('@/pages/admin/AdminSecurityPage'));

// Errors
export const UnauthorizedPage = lazy(() => import('@/pages/errors/UnauthorizedPage'));
export const NotFoundPage = lazy(() => import('@/pages/errors/NotFoundPage'));
