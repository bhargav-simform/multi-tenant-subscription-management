import type { ReactNode } from 'react';
import { AlertCircleIcon, InboxIcon, Loader2Icon, SearchXIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LABELS } from '@/constants/labels';
import { cn } from '@/lib/utils';

interface StateShellProps {
    icon: ReactNode;
    title: string;
    body?: string | undefined;
    action?: ReactNode;
    className?: string | undefined;
}

function StateShell({ icon, title, body, action, className }: StateShellProps) {
    return (
        <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
            <div className="text-muted-foreground" aria-hidden="true">
                {icon}
            </div>
            <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-foreground">{title}</p>
                {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
            </div>
            {action}
        </div>
    );
}

export function PageLoadingState({
    className,
    variant = 'spinner',
    skeletonRows = 3,
}: {
    className?: string | undefined;
    /** 'skeleton' renders content-shaped placeholder blocks instead of a spinner — use for card-grid pages. */
    variant?: 'spinner' | 'skeleton';
    skeletonRows?: number;
}) {
    if (variant === 'skeleton') {
        return (
            <div role="status" aria-live="polite" className={cn('flex flex-col gap-4', className)}>
                <span className="sr-only">{LABELS.COMMON.LOADING}</span>
                {Array.from({ length: skeletonRows }, (_, index) => (
                    <div key={index} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-4 shadow-card">
                        <Skeleton className="size-10 shrink-0 rounded-lg" />
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                            <Skeleton className="h-3 w-24" />
                            <Skeleton className="h-5 w-32" />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div
            role="status"
            aria-live="polite"
            className={cn('flex items-center justify-center gap-2 px-6 py-12 text-muted-foreground', className)}
        >
            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            <span className="text-sm">{LABELS.COMMON.LOADING}</span>
        </div>
    );
}

export function PageEmptyState({
    title = LABELS.COMMON.EMPTY,
    body,
    action,
    className,
}: {
    title?: string | undefined;
    body?: string | undefined;
    action?: ReactNode;
    className?: string | undefined;
}) {
    return <StateShell icon={<InboxIcon className="size-8" />} title={title} body={body} action={action} className={className} />;
}

export function PageErrorState({
    title = LABELS.COMMON.FETCH_ERROR,
    body,
    onRetry,
    className,
    variant = 'shell',
}: {
    title?: string | undefined;
    body?: string | undefined;
    onRetry?: (() => void) | undefined;
    className?: string | undefined;
    /** 'inline' renders a persistent Alert banner in place, for errors that sit alongside still-visible content. */
    variant?: 'shell' | 'inline';
}) {
    const retryAction = onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
            {LABELS.COMMON.RETRY}
        </Button>
    ) : undefined;

    if (variant === 'inline') {
        return (
            <Alert tone="red" className={className}>
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div className="flex flex-1 flex-col gap-2">
                    <AlertTitle>{title}</AlertTitle>
                    {body && <AlertDescription>{body}</AlertDescription>}
                    {retryAction}
                </div>
            </Alert>
        );
    }

    return (
        <StateShell icon={<AlertCircleIcon className="size-8" />} title={title} body={body} className={className} action={retryAction} />
    );
}

/**
 * What a cross-tenant read looks like from the client.
 *
 * A request for a resource belonging to another organisation returns 404 — the
 * row was filtered out by row-level security before the service's query saw it,
 * so "not yours" and "does not exist" are genuinely the same answer here. The
 * copy says so rather than implying the record exists somewhere out of reach.
 */
export function PageNotFoundState({
    title = LABELS.ERRORS.NOT_FOUND_TITLE,
    body,
    action,
    className,
}: {
    title?: string | undefined;
    body?: string | undefined;
    action?: ReactNode;
    className?: string | undefined;
}) {
    return <StateShell icon={<SearchXIcon className="size-8" />} title={title} body={body} action={action} className={className} />;
}
