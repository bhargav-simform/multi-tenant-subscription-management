import type { CSSProperties } from 'react';
import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { InfoIcon } from 'lucide-react';

import { HeaderSearchInput } from '@/components/common/header-search';
import { PageHeaderProvider } from '@/components/common/page-header';
import { ADMIN_NAV, resolveActiveNavItem, SidebarNav } from '@/components/common/sidebar';
import { UserMenu } from '@/components/common/user-menu';
import { LABELS } from '@/constants/labels';

/**
 * The platform-admin shell.
 *
 * NOTE WHAT THIS FILE DOES NOT IMPORT: no resources feature, no users feature, no
 * audit feature, no tenant hook, no tenant API module. That is deliberate and it
 * is the frontend half of the §13.6 boundary — a platform admin can see that
 * organisations exist, what plan each is on and how much it uses, and nothing
 * else. Because the admin pages share no module with the tenant pages, a content
 * component cannot be mounted here by accident; it would have to be imported on
 * purpose, and the import would be visible in review.
 *
 * The banner states the boundary to the person using the screen, so the rule is
 * legible in the product and not only in the architecture document.
 */
export default function AdminLayout() {
    const location = useLocation();
    const [titleOverride, setTitleOverride] = useState<string | undefined>(undefined);
    const [searchPlaceholder, setSearchPlaceholder] = useState<string | undefined>(undefined);

    const activeNavItem = resolveActiveNavItem(location.pathname, ADMIN_NAV);
    const title = titleOverride ?? activeNavItem?.label;
    const TitleIcon = activeNavItem?.icon;

    return (
        <div className="flex h-svh min-h-0 overflow-hidden">
            <aside
                className="bg-sidebar-admin-gradient flex w-72 shrink-0 flex-col gap-6 py-5"
                style={{ '--sidebar-active-indicator-color': 'var(--sidebar-admin-active-indicator)' } as CSSProperties}
            >
                <div className="px-6">
                    <p className="truncate text-base font-semibold text-sidebar-foreground">{LABELS.ADMIN.TITLE}</p>
                    <p className="truncate text-xs text-sidebar-foreground/70">{LABELS.ADMIN.METADATA_ONLY}</p>
                </div>
                <SidebarNav items={ADMIN_NAV} />
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
                    <div className="mb-5 flex items-start gap-2 rounded-lg border border-border bg-section-header-bg px-4 py-3">
                        <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <p className="text-sm text-muted-foreground">{LABELS.ADMIN.METADATA_ONLY_BODY}</p>
                    </div>
                    <PageHeaderProvider value={{ setTitle: setTitleOverride, setSearchPlaceholder }}>
                        <Outlet />
                    </PageHeaderProvider>
                </main>
            </div>
        </div>
    );
}
