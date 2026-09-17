import { Link } from 'react-router-dom';

import { PageErrorState, PageLoadingState } from '@/components/common/page-state';
import { StatusBadge } from '@/components/common/status-badge';
import { UsageMeter } from '@/components/common/usage-meter';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useAuth } from '@/contexts/useAuth';
import { useDashboard } from '@/hooks/dashboard/queries';
import { formatBytes, fullName } from '@/lib/utils';
import type { CursorPage, User } from '@/types/api';

/** The aggregate route may hand back a page envelope or a bare array. */
const toUserList = (recentUsers: CursorPage<User> | User[] | undefined): User[] => {
    if (!recentUsers) return [];
    return Array.isArray(recentUsers) ? recentUsers : recentUsers.items;
};

export default function DashboardPage() {
    const { isOrgAdmin } = useAuth();
    const { data, isLoading, isError, refetch } = useDashboard();

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
                <Card>
                    <CardHeader>
                        <CardDescription>{LABELS.DASHBOARD.PLAN}</CardDescription>
                        <CardTitle className="text-2xl">{subscription.planName}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <StatusBadge tone={subscription.status === 'active' ? 'green' : 'amber'}>
                            {subscription.status}
                        </StatusBadge>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardDescription>{LABELS.DASHBOARD.SEATS}</CardDescription>
                        <CardTitle className="text-2xl tabular-nums">
                            {subscription.usedSeats} / {subscription.maxSeats}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <UsageMeter
                            label={LABELS.PLAN.SEATS_LABEL}
                            used={subscription.usedSeats}
                            max={subscription.maxSeats}
                        />
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardDescription>{LABELS.DASHBOARD.STORAGE}</CardDescription>
                        <CardTitle className="text-2xl">{formatBytes(subscription.usedStorageBytes)}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <UsageMeter
                            label={LABELS.PLAN.STORAGE_LABEL}
                            used={subscription.usedStorageBytes}
                            max={subscription.maxStorageBytes}
                            format={formatBytes}
                        />
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>{LABELS.DASHBOARD.RECENT_USERS}</CardTitle>
                    <CardDescription>
                        {recentUsers.length === 0 ? LABELS.DASHBOARD.NO_RECENT_USERS : ' '}
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    {recentUsers.map((user) => (
                        <div key={user.id} className="flex items-center justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
                            <div className="flex min-w-0 flex-col">
                                <span className="truncate text-sm font-medium">
                                    {fullName(user.firstName, user.lastName) || user.email}
                                </span>
                                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
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
        </div>
    );
}
