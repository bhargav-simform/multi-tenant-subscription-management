import { NavLink } from 'react-router-dom';
import { BuildingIcon, CreditCardIcon, FilesIcon, LayoutDashboardIcon, ScrollTextIcon, ShieldAlertIcon, UsersIcon } from 'lucide-react';

import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { cn } from '@/lib/utils';

export interface NavItem {
    to: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
}

/** Tenant navigation. Every item here reaches the caller's own organisation only. */
export const TENANT_NAV: NavItem[] = [
    { to: ROUTES.DASHBOARD, label: LABELS.NAV.DASHBOARD, icon: LayoutDashboardIcon },
    { to: ROUTES.RESOURCES, label: LABELS.NAV.RESOURCES, icon: FilesIcon },
    { to: ROUTES.AUDIT, label: LABELS.NAV.AUDIT, icon: ScrollTextIcon },
];

/** Org-admin-only additions. Hidden for a member — and refused by the server regardless. */
export const ORG_ADMIN_NAV: NavItem[] = [
    { to: ROUTES.USERS, label: LABELS.NAV.USERS, icon: UsersIcon },
    { to: ROUTES.PLAN, label: LABELS.NAV.PLAN, icon: CreditCardIcon },
];

/** Platform-admin navigation. Metadata destinations only — no content route exists. */
export const ADMIN_NAV: NavItem[] = [
    { to: ROUTES.ADMIN_ORGANIZATIONS, label: LABELS.NAV.ORGANIZATIONS, icon: BuildingIcon },
    { to: ROUTES.ADMIN_SECURITY, label: LABELS.NAV.SECURITY, icon: ShieldAlertIcon },
];

export function SidebarNav({ items }: { items: NavItem[] }) {
    return (
        <nav className="flex flex-col gap-1 px-3" aria-label="Main">
            {items.map(({ to, label, icon: Icon }) => (
                <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) =>
                        cn(
                            'relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                            'text-sidebar-foreground/80 hover:bg-sidebar-active-highlight/60 hover:text-sidebar-foreground',
                            'focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none',
                            isActive &&
                                cn(
                                    'bg-sidebar-active-highlight text-sidebar-foreground',
                                    'before:absolute before:top-1/2 before:left-0 before:h-5 before:w-1 before:-translate-y-1/2',
                                    'before:rounded-r-full before:bg-(--sidebar-active-indicator-color)',
                                ),
                        )
                    }
                >
                    <Icon className="size-4 shrink-0" />
                    <span>{label}</span>
                </NavLink>
            ))}
        </nav>
    );
}
