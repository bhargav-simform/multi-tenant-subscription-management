import { Outlet } from 'react-router-dom';

import { ORG_ADMIN_NAV, SidebarNav, TENANT_NAV } from '@/components/common/sidebar';
import { UserMenu } from '@/components/common/user-menu';
import { LABELS } from '@/constants/labels';
import { useAuth } from '@/contexts/useAuth';
import { useMyOrganization } from '@/hooks/organization/queries';

/**
 * The tenant shell — org admins and org members.
 *
 * This layout imports content features (resources, users, plan, audit). Its
 * counterpart, AdminLayout, imports none of them, and that separation is the
 * point: the two shells share no feature module, so a content table cannot end
 * up on a platform-admin screen through an unconsidered import.
 */
export default function TenantLayout() {
    const { isOrgAdmin } = useAuth();
    const { data: organization } = useMyOrganization();

    // Members never see the user-management or plan items. This is presentation
    // only — user-service and subscription-service refuse those calls from a
    // member whether or not the link was ever rendered.
    const navItems = isOrgAdmin ? [...TENANT_NAV, ...ORG_ADMIN_NAV] : TENANT_NAV;

    return (
        <div className="flex h-svh min-h-0 overflow-hidden">
            <aside className="bg-sidebar-gradient flex w-64 shrink-0 flex-col gap-6 py-5">
                <div className="px-6">
                    <p className="truncate text-base font-semibold text-sidebar-foreground">
                        {organization?.name ?? LABELS.COMMON.APP_NAME}
                    </p>
                    {organization && (
                        <p className="truncate text-xs text-sidebar-foreground/70">{organization.slug}</p>
                    )}
                </div>
                <SidebarNav items={navItems} />
            </aside>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <header className="flex h-16 shrink-0 items-center justify-end gap-3 border-b border-border bg-card px-4">
                    <UserMenu />
                </header>
                <main className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden p-6">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
