import { CreditCardIcon, HardDriveIcon, UsersIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Avatar } from '@/components/common/avatar';
import { useSetSearchPlaceholder } from '@/components/common/page-header';
import { PageErrorState, PageLoadingState } from '@/components/common/page-state';
import { RingProgress } from '@/components/common/ring-progress';
import { StatCard } from '@/components/common/stat-card';
import { StatusBadge } from '@/components/common/status-badge';
import { UsageMeter } from '@/components/common/usage-meter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useAuth } from '@/contexts/useAuth';
import { useDashboard } from '@/hooks/dashboard/queries';
import { cn, formatBytes, fullName } from '@/lib/utils';
import type { CursorPage, User } from '@/types/api';

import { QuickActionsPanel } from './QuickActionsPanel';

/** The aggregate route may hand back a page envelope or a bare array. */
const toUserList = (recentUsers: CursorPage<User> | User[] | undefined): User[] => {
    if (!recentUsers) return [];
    return Array.isArray(recentUsers) ? recentUsers : recentUsers.items;
};

export default function DashboardPage() {
    const { isOrgAdmin } = useAuth();
    const { data, isLoading, isError, refetch } = useDashboard();
    useSetSearchPlaceholder(LABELS.SIDEBAR.SEARCH_PLACEHOLDER_DASHBOARD);

    if (isLoading) return <PageLoadingState />;
    if (isError || !data) return <PageErrorState onRetry={() => void refetch()} />;

    const { subscription } = data;
    const recentUsers = toUserList(data.recentUsers);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
                <h1>{LABELS.DASHBOARD.TITLE}</h1>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
                <StatCard icon={CreditCardIcon} tone="violet" label={LABELS.DASHBOARD.PLAN} value={subscription.planName}>
                    <StatusBadge tone={subscription.status === 'active' ? 'green' : 'amber'}>{subscription.status}</StatusBadge>
                </StatCard>

                <StatCard
                    icon={UsersIcon}
                    tone="teal"
                    label={LABELS.DASHBOARD.SEATS}
                    value={
                        <span className="tabular-nums">
                            {subscription.usedSeats} / {subscription.maxSeats}
                        </span>
                    }
                >
                    <RingProgress used={subscription.usedSeats} max={subscription.maxSeats} label={LABELS.PLAN.SEATS_LABEL} />
                </StatCard>

                <StatCard
                    icon={HardDriveIcon}
                    tone="amber"
                    label={LABELS.DASHBOARD.STORAGE}
                    value={formatBytes(subscription.usedStorageBytes)}
                >
                    <UsageMeter
                        label={LABELS.PLAN.STORAGE_LABEL}
                        used={subscription.usedStorageBytes}
                        max={subscription.maxStorageBytes}
                        format={formatBytes}
                    />
                </StatCard>
            </div>

            <div className={cn('grid gap-4', isOrgAdmin && 'lg:grid-cols-3')}>
                <Card className={cn(isOrgAdmin && 'lg:col-span-2')}>
                    <CardHeader>
                        <CardTitle>{LABELS.DASHBOARD.RECENT_USERS}</CardTitle>
                        <CardDescription>
                            {recentUsers.length === 0 ? LABELS.DASHBOARD.NO_RECENT_USERS : ' '}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                        {recentUsers.map((user) => (
                            <div key={user.id} className="flex items-center justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
                                <div className="flex min-w-0 items-center gap-3">
                                    <Avatar seed={user.email} initials={user.email.slice(0, 2).toUpperCase()} />
                                    <div className="flex min-w-0 flex-col">
                                        <span className="truncate text-sm font-medium">
                                            {fullName(user.firstName, user.lastName) || user.email}
                                        </span>
                                        <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                                    </div>
                                </div>
                                <StatusBadge tone={user.status === 'active' ? 'green' : 'amber'}>{user.status}</StatusBadge>
                            </div>
                        ))}

                        {isOrgAdmin && recentUsers.length > 0 && (
                            <Link to={ROUTES.USERS} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
                                {LABELS.DASHBOARD.VIEW_ALL_USERS}
                            </Link>
                        )}
                    </CardContent>
                </Card>

                {isOrgAdmin && <QuickActionsPanel />}
            </div>
        </div>
    );
}
