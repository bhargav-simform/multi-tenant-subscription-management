import { Outlet } from 'react-router-dom';
import { InfoIcon } from 'lucide-react';

import { ADMIN_NAV, SidebarNav } from '@/components/common/sidebar';
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
    return (
        <div className="flex h-svh min-h-0 overflow-hidden">
            <aside className="bg-sidebar-admin-gradient flex w-64 shrink-0 flex-col gap-6 py-5">
                <div className="px-6">
                    <p className="truncate text-base font-semibold text-sidebar-foreground">{LABELS.ADMIN.TITLE}</p>
                    <p className="truncate text-xs text-sidebar-foreground/70">{LABELS.ADMIN.METADATA_ONLY}</p>
                </div>
                <SidebarNav items={ADMIN_NAV} />
            </aside>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <header className="flex h-16 shrink-0 items-center justify-end gap-3 border-b border-border bg-card px-4">
                    <UserMenu />
                </header>
                <main className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden p-6">
                    <div className="mb-5 flex items-start gap-2 rounded-lg border border-border bg-section-header-bg px-4 py-3">
                        <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <p className="text-sm text-muted-foreground">{LABELS.ADMIN.METADATA_ONLY_BODY}</p>
                    </div>
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
