import type { CSSProperties } from 'react';
import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { HeaderSearchInput } from '@/components/common/header-search';
import { PageHeaderProvider } from '@/components/common/page-header';
import { ORG_ADMIN_NAV, resolveActiveNavItem, SidebarNav, StorageUpsellCard, TENANT_NAV } from '@/components/common/sidebar';
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
    const location = useLocation();
    const [titleOverride, setTitleOverride] = useState<string | undefined>(undefined);
    const [searchPlaceholder, setSearchPlaceholder] = useState<string | undefined>(undefined);

    // Members never see the user-management or plan items. This is presentation
    // only — user-service and subscription-service refuse those calls from a
    // member whether or not the link was ever rendered.
    const navItems = isOrgAdmin ? [...TENANT_NAV, ...ORG_ADMIN_NAV] : TENANT_NAV;
    const activeNavItem = resolveActiveNavItem(location.pathname, navItems);
    const title = titleOverride ?? activeNavItem?.label;
    const TitleIcon = activeNavItem?.icon;

    return (
        <div className="flex h-svh min-h-0 overflow-hidden">
            <aside
                className="bg-sidebar-gradient flex w-72 shrink-0 flex-col gap-6 py-5"
                style={{ '--sidebar-active-indicator-color': 'var(--sidebar-active-indicator)' } as CSSProperties}
            >
                <div className="px-6">
                    <p className="truncate text-base font-semibold text-sidebar-foreground">
                        {organization?.name ?? LABELS.COMMON.APP_NAME}
                    </p>
                    {organization && (
                        <p className="truncate text-xs text-sidebar-foreground/70">{organization.slug}</p>
                    )}
                </div>
                <SidebarNav items={navItems} />
                <div className="mt-auto">
                    <StorageUpsellCard />
                </div>
            </aside>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-6">
                    {searchPlaceholder ? (
                        <HeaderSearchInput placeholder={searchPlaceholder} />
                    ) : (
                        <div className="flex min-w-0 items-center gap-2">
                            {TitleIcon && <TitleIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                            {title && <h2 className="truncate text-lg font-semibold">{title}</h2>}
                        </div>
                    )}
                    <UserMenu />
                </header>
                <main className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden p-6">
                    <PageHeaderProvider value={{ setTitle: setTitleOverride, setSearchPlaceholder }}>
                        <Outlet />
                    </PageHeaderProvider>
                </main>
            </div>
        </div>
    );
}
