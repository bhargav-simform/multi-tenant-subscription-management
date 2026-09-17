import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable, useCursorPagination } from '@/components/common/data-table';
import { StatusBadge } from '@/components/common/status-badge';
import { ORGANIZATION_STATUS } from '@/constants/common';
import { LABELS } from '@/constants/labels';
import { buildRoute } from '@/constants/routes';
import { useAdminOrganizations, useAdminUsage } from '@/hooks/admin/queries';
import { formatBytes } from '@/lib/utils';
import type { Organization, UsageAggregate } from '@/types/api';

/**
 * Every organisation on the platform — name, slug, status, plan, and counts.
 *
 * WHAT IS NOT ON THIS PAGE, and cannot be: any organisation's content. There is
 * no cell here that renders a resource, a user's name or an audit payload,
 * because this file imports nothing from the tenant features and the gateway
 * exposes no route that would serve that data to a platform admin anyway.
 *
 * The list is server-paginated with keyset cursors. It has to be: this is the one
 * table that grows with every customer the platform ever signs.
 */
export default function AdminOrganizationsPage() {
    const navigate = useNavigate();
    const { cursor, canGoPrevious, goNext, goPrevious } = useCursorPagination();
    const { data, isLoading, isError, isFetching, refetch } = useAdminOrganizations(cursor);
    const { data: usage } = useAdminUsage();

    // Usage arrives as its own aggregate list; joined by id for display only.
    const usageByOrg = useMemo(() => {
        const map = new Map<string, UsageAggregate>();
        for (const entry of usage ?? []) map.set(entry.organizationId, entry);
        return map;
    }, [usage]);

    const columns = useMemo<ColumnDef<Organization>[]>(
        () => [
            {
                accessorKey: 'name',
                header: LABELS.ADMIN.ORG_NAME,
                cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
            },
            {
                accessorKey: 'slug',
                header: LABELS.ADMIN.SLUG,
                cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.slug}</span>,
            },
            {
                accessorKey: 'status',
                header: LABELS.ADMIN.STATUS,
                cell: ({ row }) => (
                    <StatusBadge tone={row.original.status === ORGANIZATION_STATUS.ACTIVE ? 'green' : 'amber'}>
                        {row.original.status}
                    </StatusBadge>
                ),
            },
            {
                id: 'plan',
                header: LABELS.ADMIN.PLAN,
                cell: ({ row }) => {
                    const entry = usageByOrg.get(row.original.id);
                    return entry ? <StatusBadge tone="teal">{entry.planCode}</StatusBadge> : <span>{LABELS.COMMON.NO_DATA}</span>;
                },
            },
            {
                id: 'seats',
                header: LABELS.ADMIN.SEATS,
                cell: ({ row }) => {
                    const entry = usageByOrg.get(row.original.id);
                    if (!entry) return <span className="text-muted-foreground">{LABELS.COMMON.NO_DATA}</span>;
                    return (
                        <span className="tabular-nums">
                            {entry.usedSeats} / {entry.maxSeats}
                        </span>
                    );
                },
            },
            {
                id: 'storage',
                header: LABELS.ADMIN.STORAGE,
                cell: ({ row }) => {
                    const entry = usageByOrg.get(row.original.id);
                    if (!entry) return <span className="text-muted-foreground">{LABELS.COMMON.NO_DATA}</span>;
                    return (
                        <span className="whitespace-nowrap tabular-nums">
                            {formatBytes(entry.usedStorageBytes)} / {formatBytes(entry.maxStorageBytes)}
                        </span>
                    );
                },
            },
        ],
        [usageByOrg],
    );

    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
                <h1>{LABELS.ADMIN.ORGANIZATIONS}</h1>
                <p className="text-sm text-muted-foreground">{LABELS.ADMIN.ORGANIZATIONS_SUBTITLE}</p>
            </div>

            <DataTable
                columns={columns}
                data={data?.items ?? []}
                isLoading={isLoading}
                isError={isError}
                onRetry={() => void refetch()}
                emptyMessage={LABELS.ADMIN.EMPTY}
                onRowClick={(organization) => void navigate(buildRoute.adminOrganizationDetail(organization.id))}
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
