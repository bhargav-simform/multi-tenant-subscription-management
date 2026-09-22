import { Link, useParams } from 'react-router-dom';
import { ArrowLeftIcon } from 'lucide-react';

import { useSetPageTitle } from '@/components/common/page-header';
import { PageErrorState, PageLoadingState, PageNotFoundState } from '@/components/common/page-state';
import { StatusBadge } from '@/components/common/status-badge';
import { UsageMeter } from '@/components/common/usage-meter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ORGANIZATION_STATUS } from '@/constants/common';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useAdminOrganization, useAdminUsage } from '@/hooks/admin/queries';
import { formatBytes } from '@/lib/utils';

/**
 * One organisation, as a platform admin sees it: its metadata and its counts.
 *
 * This is the page where the temptation to "just add a resources list" would
 * live, and where doing so would fail the POC. It renders seats and bytes —
 * numbers about content, never content. Nothing on this screen can be expanded
 * into rows, because no route exists that would return them to this caller.
 */
export default function AdminOrganizationDetailPage() {
    const { id } = useParams<{ id: string }>();
    const { data: organization, isLoading, isError, refetch } = useAdminOrganization(id);
    const { data: usage } = useAdminUsage(id);

    useSetPageTitle(organization?.name);

    const entry = usage?.[0];

    const backLink = (
        <Button variant="outline" size="sm" asChild>
            <Link to={ROUTES.ADMIN_ORGANIZATIONS}>
                <ArrowLeftIcon />
                {LABELS.ADMIN.ORGANIZATIONS}
            </Link>
        </Button>
    );

    if (isLoading) return <PageLoadingState />;
    if (isError) return <PageErrorState onRetry={() => void refetch()} />;
    if (!organization) return <PageNotFoundState action={backLink} />;

    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <h1>{organization.name}</h1>
                    <p className="font-mono text-sm text-muted-foreground">{organization.slug}</p>
                </div>
                {backLink}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardDescription>{LABELS.ADMIN.STATUS}</CardDescription>
                        <CardTitle className="text-xl">
                            <StatusBadge tone={organization.status === ORGANIZATION_STATUS.ACTIVE ? 'green' : 'amber'}>
                                {organization.status}
                            </StatusBadge>
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="font-mono text-xs text-muted-foreground">{organization.id}</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardDescription>{LABELS.ADMIN.PLAN}</CardDescription>
                        <CardTitle className="text-xl">{entry?.planCode ?? LABELS.COMMON.NO_DATA}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        {entry ? (
                            <>
                                <UsageMeter label={LABELS.ADMIN.SEATS} used={entry.usedSeats} max={entry.maxSeats} />
                                <UsageMeter
                                    label={LABELS.ADMIN.STORAGE}
                                    used={entry.usedStorageBytes}
                                    max={entry.maxStorageBytes}
                                    format={formatBytes}
                                />
                            </>
                        ) : (
                            <p className="text-sm text-muted-foreground">{LABELS.COMMON.NO_DATA}</p>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
