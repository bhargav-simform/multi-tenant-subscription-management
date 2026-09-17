import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable, useCursorPagination } from '@/components/common/data-table';
import { StatusBadge, type BadgeTone } from '@/components/common/status-badge';
import { LABELS } from '@/constants/labels';
import { useAuditEvents } from '@/hooks/audit/queries';
import { formatDateTime } from '@/lib/utils';
import type { AuditEvent, AuditSeverity } from '@/types/api';

export const SEVERITY_TONE: Record<AuditSeverity, BadgeTone> = {
    info: 'slate',
    warning: 'amber',
    security: 'red',
    critical: 'red',
};

/**
 * The organisation's own audit trail.
 *
 * Onboarding, plan-limit rejections and cross-tenant access attempts all land
 * here as structured records. Events arrive at audit-service over Kafka and only
 * over Kafka, so this list is append-only from the client's point of view —
 * there is no write route to call, by design.
 */
export default function AuditPage() {
    const { cursor, canGoPrevious, goNext, goPrevious } = useCursorPagination();
    const { data, isLoading, isError, isFetching, refetch } = useAuditEvents(cursor);

    const columns = useMemo<ColumnDef<AuditEvent>[]>(
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
                <h1>{LABELS.AUDIT.TITLE}</h1>
                <p className="text-sm text-muted-foreground">{LABELS.AUDIT.SUBTITLE}</p>
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
