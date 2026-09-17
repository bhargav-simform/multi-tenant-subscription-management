import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { PageLoadingState } from '@/components/common/page-state';
import { ROUTES } from '@/constants/routes';
import { useAuth } from '@/contexts/useAuth';

/**
 * Route guards decide what to RENDER. They do not decide what is permitted.
 *
 * Every route below is also enforced server-side — by the gateway's
 * PlatformAdminGuard, by each service's CASL rules, and underneath both by RLS.
 * A user who edits their cached identity or types an admin URL gets a shell they
 * are not entitled to and an API that refuses every request it makes. Hiding a
 * route is UX; the server is the control.
 */

/** Any authenticated caller. */
export function ProtectedRoute() {
    const { isAuthenticated, isBootstrapping } = useAuth();
    const location = useLocation();

    if (isBootstrapping) return <PageLoadingState className="h-screen" />;
    if (!isAuthenticated) return <Navigate to={ROUTES.LOGIN} state={{ from: location }} replace />;

    return <Outlet />;
}

/**
 * The tenant shell — org admins and org members.
 *
 * A platform admin is redirected OUT of here rather than merely warned. They have
 * no organisation (organizationId is NULL), so every tenant screen would fire
 * requests that cannot resolve; sending them to their own shell is both kinder
 * and a visible statement of the boundary.
 */
export function TenantRoute() {
    const { isAuthenticated, isBootstrapping, isPlatformAdmin } = useAuth();
    const location = useLocation();

    if (isBootstrapping) return <PageLoadingState className="h-screen" />;
    if (!isAuthenticated) return <Navigate to={ROUTES.LOGIN} state={{ from: location }} replace />;
    if (isPlatformAdmin) return <Navigate to={ROUTES.ADMIN_ORGANIZATIONS} replace />;

    return <Outlet />;
}

/** Org-admin-only screens within the tenant shell (user management, plan changes). */
export function OrgAdminRoute() {
    const { isAuthenticated, isBootstrapping, isOrgAdmin } = useAuth();
    const location = useLocation();

    if (isBootstrapping) return <PageLoadingState className="h-screen" />;
    if (!isAuthenticated) return <Navigate to={ROUTES.LOGIN} state={{ from: location }} replace />;
    if (!isOrgAdmin) return <Navigate to={ROUTES.UNAUTHORIZED} replace />;

    return <Outlet />;
}

/** The platform-admin shell — metadata only, and structurally separate. */
export function PlatformAdminRoute() {
    const { isAuthenticated, isBootstrapping, isPlatformAdmin } = useAuth();
    const location = useLocation();

    if (isBootstrapping) return <PageLoadingState className="h-screen" />;
    if (!isAuthenticated) return <Navigate to={ROUTES.LOGIN} state={{ from: location }} replace />;
    if (!isPlatformAdmin) return <Navigate to={ROUTES.UNAUTHORIZED} replace />;

    return <Outlet />;
}

/** Login/signup — an authenticated caller is sent to their own home. */
export function PublicOnlyRoute() {
    const { isAuthenticated, isBootstrapping, isPlatformAdmin } = useAuth();

    if (isBootstrapping) return <PageLoadingState className="h-screen" />;
    if (isAuthenticated) return <Navigate to={isPlatformAdmin ? ROUTES.ADMIN_ORGANIZATIONS : ROUTES.DASHBOARD} replace />;

    return <Outlet />;
}
