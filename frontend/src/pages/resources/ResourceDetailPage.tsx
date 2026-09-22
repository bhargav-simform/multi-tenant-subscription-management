import { Link, useParams } from 'react-router-dom';
import { ArrowLeftIcon } from 'lucide-react';

import { useSetPageTitle } from '@/components/common/page-header';
import { PageErrorState, PageLoadingState, PageNotFoundState } from '@/components/common/page-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useResource } from '@/hooks/resources/queries';
import { formatBytes, formatDateTime, getErrorStatus } from '@/lib/utils';

/**
 * H1 — the sharpest cross-tenant case in this system, seen from the client.
 *
 * Paste another organisation's resource id into this URL and the screen below
 * renders "does not exist". No check in this component produced that: the request
 * went out well-formed, resource-service ran its query, and PostgreSQL row-level
 * security had already removed the row from what that query could see. The client
 * is told 404 because, for this caller, the row genuinely is not there.
 *
 * That is why the not-found copy does not hedge with "you don't have permission" —
 * phrasing it that way would confirm the id exists somewhere, which is exactly the
 * information a tenant boundary is supposed to withhold.
 */
export default function ResourceDetailPage() {
    const { id } = useParams<{ id: string }>();
    const { data: resource, isLoading, isError, error, refetch } = useResource(id);

    useSetPageTitle(resource?.name);

    const backLink = (
        <Button variant="outline" size="sm" asChild>
            <Link to={ROUTES.RESOURCES}>
                <ArrowLeftIcon />
                {LABELS.RESOURCES.TITLE}
            </Link>
        </Button>
    );

    if (isLoading) return <PageLoadingState />;

    if (isError) {
        // 404 is the expected, correct answer for a foreign-tenant id — not a failure.
        if (getErrorStatus(error) === 404) {
            return (
                <PageNotFoundState
                    title={LABELS.RESOURCES.NOT_FOUND}
                    body={LABELS.RESOURCES.NOT_FOUND_BODY}
                    action={backLink}
                />
            );
        }
        return <PageErrorState onRetry={() => void refetch()} />;
    }

    if (!resource) return <PageNotFoundState title={LABELS.RESOURCES.NOT_FOUND} action={backLink} />;

    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <h1>{resource.name}</h1>
                    <p className="text-sm text-muted-foreground">{resource.description || LABELS.COMMON.NO_DATA}</p>
                </div>
                {backLink}
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>{LABELS.RESOURCES.TITLE}</CardTitle>
                    <CardDescription>{resource.id}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-3">
                    <Field label={LABELS.RESOURCES.SIZE} value={formatBytes(resource.sizeBytes)} />
                    <Field label={LABELS.RESOURCES.CREATED_BY} value={resource.createdBy} />
                    <Field label={LABELS.RESOURCES.CREATED_AT} value={formatDateTime(resource.createdAt)} />
                </CardContent>
            </Card>
        </div>
    );
}

function Field({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <span className="truncate text-sm">{value}</span>
        </div>
    );
}
