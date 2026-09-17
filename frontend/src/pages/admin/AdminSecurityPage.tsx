import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable, useCursorPagination } from '@/components/common/data-table';
import { StatusBadge, type BadgeTone } from '@/components/common/status-badge';
import { LABELS } from '@/constants/labels';
import { useSecurityEvents } from '@/hooks/admin/queries';
import { formatDateTime } from '@/lib/utils';
import type { AuditEventMetadata, AuditSeverity } from '@/types/api';

const SEVERITY_TONE: Record<AuditSeverity, BadgeTone> = {
    info: 'slate',
    warning: 'amber',
    security: 'red',
    critical: 'red',
};

/**
 * Security-severity events across the platform — the production tenant-leak signal.
 *
 * A cross-tenant access attempt records an event here, which is what makes a leak
 * detectable while it is happening rather than explicable afterwards. Note that
 * only the METADATA is rendered: event type, severity, the organisation the
 * attempt touched, the actor and the correlation id. The payload column is
 * deliberately absent — a security event's payload can quote the record that was
 * reached for, and printing it on a platform-admin screen would leak the very
 * content this boundary exists to protect.
 */
export default function AdminSecurityPage() {
    const { cursor, canGoPrevious, goNext, goPrevious } = useCursorPagination();
    const { data, isLoading, isError, isFetching, refetch } = useSecurityEvents(cursor);

    const columns = useMemo<ColumnDef<AuditEventMetadata>[]>(
        () => [
            {
                accessorKey: 'eventType',
                header: LABELS.AUDIT.EVENT,
                cell: ({ row }) => <span className="font-medium">{row.original.eventType}</span>,
            },
            {
                accessorKey: 'severity',
                header: LABELS.AUDIT.SEVERITY,
                cell: ({ row }) => (
                    <StatusBadge tone={SEVERITY_TONE[row.original.severity] ?? 'slate'}>
                        {row.original.severity}
                    </StatusBadge>
                ),
            },
            {
                accessorKey: 'organizationId',
                header: LABELS.ADMIN.ORG_NAME,
                cell: ({ row }) => (
                    <span className="font-mono text-xs text-muted-foreground">
                        {row.original.organizationId ?? LABELS.COMMON.NO_DATA}
                    </span>
                ),
            },
            {
                accessorKey: 'actorUserId',
                header: LABELS.AUDIT.ACTOR,
                cell: ({ row }) => (
                    <span className="font-mono text-xs text-muted-foreground">
                        {row.original.actorUserId ?? LABELS.COMMON.NO_DATA}
                    </span>
                ),
            },
            {
                accessorKey: 'correlationId',
                header: LABELS.AUDIT.CORRELATION,
                cell: ({ row }) => (
                    <span className="font-mono text-xs text-muted-foreground">{row.original.correlationId}</span>
                ),
            },
            {
                accessorKey: 'occurredAt',
                header: LABELS.AUDIT.WHEN,
                cell: ({ row }) => (
                    <span className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(row.original.occurredAt)}
                    </span>
                ),
            },
        ],
        [],
    );

    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
                <h1>{LABELS.ADMIN.SECURITY}</h1>
                <p className="text-sm text-muted-foreground">{LABELS.ADMIN.SECURITY_SUBTITLE}</p>
            </div>

            <DataTable
                columns={columns}
                data={data?.items ?? []}
                isLoading={isLoading}
                isError={isError}
                onRetry={() => void refetch()}
                emptyMessage={LABELS.AUDIT.EMPTY}
                pagination={{
                    canGoPrevious,
                    canGoNext: Boolean(data?.nextCursor),
                    onPrevious: goPrevious,
                    onNext: () => goNext(data?.nextCursor),
                    isFetching,
                }}
            />
        </div>
    );
}
