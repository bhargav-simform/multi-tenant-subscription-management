import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable, useCursorPagination } from '@/components/common/data-table';
import { StatusBadge, type BadgeTone } from '@/components/common/status-badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AUDIT_EVENT_TYPE } from '@/constants/common';
import { LABELS } from '@/constants/labels';
import { useAuditEvents } from '@/hooks/audit/queries';
import { formatDateTime } from '@/lib/utils';
import type { AuditEvent, AuditSeverity } from '@/types/api';

/** "All events" needs a Select value, and Select never accepts an empty string. */
const ALL_EVENT_TYPES = 'all';

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
    const { cursor, canGoPrevious, goNext, goPrevious, reset } = useCursorPagination();
    const [eventType, setEventType] = useState<string>(ALL_EVENT_TYPES);
    const { data, isLoading, isError, isFetching, refetch } = useAuditEvents(
        cursor,
        undefined,
        eventType === ALL_EVENT_TYPES ? undefined : eventType,
    );

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
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <h1>{LABELS.AUDIT.TITLE}</h1>
                    <p className="text-sm text-muted-foreground">{LABELS.AUDIT.SUBTITLE}</p>
                </div>

                <Select
                    value={eventType}
                    onValueChange={(value) => {
                        setEventType(value);
                        // A changed filter is a new list — start from its first page,
                        // same as any mutation that changes what this list contains.
                        reset();
                    }}
                >
                    <SelectTrigger className="w-56" aria-label={LABELS.AUDIT.FILTER_EVENT_TYPE}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL_EVENT_TYPES}>{LABELS.AUDIT.FILTER_ALL_EVENTS}</SelectItem>
                        {Object.values(AUDIT_EVENT_TYPE).map((type) => (
                            <SelectItem key={type} value={type}>
                                {type}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <DataTable
                columns={columns}
                data={data?.items ?? []}
                isLoading={isLoading}
                isError={isError}
                onRetry={() => void refetch()}
                emptyMessage={eventType === ALL_EVENT_TYPES ? LABELS.AUDIT.EMPTY : LABELS.AUDIT.EMPTY_FILTERED}
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
