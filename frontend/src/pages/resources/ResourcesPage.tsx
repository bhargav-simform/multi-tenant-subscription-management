import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { PlusIcon, Trash2Icon } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DataTable, useCursorPagination } from '@/components/common/data-table';
import { FileTypeTile } from '@/components/common/file-type-tile';
import { FilterChipGroup } from '@/components/common/filter-chip-group';
import { useSetSearchPlaceholder } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { LABELS } from '@/constants/labels';
import { buildRoute } from '@/constants/routes';
import { useDeleteResource } from '@/hooks/resources/mutations';
import { useResources } from '@/hooks/resources/queries';
import { formatBytes, formatDateTime, interpolate } from '@/lib/utils';
import { RESOURCE_SORT, type Resource, type ResourceSort } from '@/types/api';

import { ResourceFormDialog } from './ResourceFormDialog';

/** Each chip maps to a real server-side sort/filter param — see useResources. */
const FILTER_CHIPS: { id: string; label: string; sort?: ResourceSort; hasDescription?: 'true' | 'false' }[] = [
    { id: 'all', label: 'All files' },
    { id: 'largest', label: 'Largest first', sort: RESOURCE_SORT.SIZE_BYTES },
    { id: 'recent', label: 'Recently added', sort: RESOURCE_SORT.CREATED_AT },
    { id: 'no-description', label: 'No description', hasDescription: 'false' },
];

export default function ResourcesPage() {
    const navigate = useNavigate();
    const { cursor, canGoPrevious, goNext, goPrevious, reset } = useCursorPagination();
    const [activeFilterId, setActiveFilterId] = useState('all');
    const activeFilter = FILTER_CHIPS.find((chip) => chip.id === activeFilterId);
    const { data, isLoading, isError, isFetching, refetch } = useResources(
        cursor,
        undefined,
        activeFilter?.sort,
        activeFilter?.hasDescription,
    );
    const { mutate: deleteResource, isPending: isDeleting } = useDeleteResource();
    useSetSearchPlaceholder(LABELS.SIDEBAR.SEARCH_PLACEHOLDER_RESOURCES);

    const [isCreateOpen, setCreateOpen] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<Resource | null>(null);

    const columns = useMemo<ColumnDef<Resource>[]>(
        () => [
            {
                accessorKey: 'name',
                header: LABELS.RESOURCES.NAME,
                cell: ({ row }) => (
                    <div className="flex items-center gap-3">
                        <FileTypeTile resource={row.original} />
                        <span className="font-medium">{row.original.name}</span>
                    </div>
                ),
            },
            {
                accessorKey: 'description',
                header: LABELS.RESOURCES.DESCRIPTION,
                cell: ({ row }) => (
                    <span className="text-muted-foreground">{row.original.description || LABELS.COMMON.NO_DATA}</span>
                ),
            },
            {
                accessorKey: 'sizeBytes',
                header: LABELS.RESOURCES.SIZE,
                cell: ({ row }) => <span className="tabular-nums">{formatBytes(row.original.sizeBytes)}</span>,
            },
            {
                accessorKey: 'createdAt',
                header: LABELS.RESOURCES.CREATED_AT,
                cell: ({ row }) => (
                    <span className="text-muted-foreground">{formatDateTime(row.original.createdAt)}</span>
                ),
            },
            {
                id: 'actions',
                header: '',
                size: 64,
                cell: ({ row }) => (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={interpolate(LABELS.RESOURCES.DELETE_TITLE, { name: row.original.name })}
                        onClick={(event) => {
                            // The row itself navigates to the detail view; the delete
                            // button must not do both.
                            event.stopPropagation();
                            setPendingDelete(row.original);
                        }}
                    >
                        <Trash2Icon className="text-muted-foreground" />
                    </Button>
                ),
            },
        ],
        [],
    );

    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <h1>{LABELS.RESOURCES.TITLE}</h1>
                    <p className="text-sm text-muted-foreground">{LABELS.RESOURCES.SUBTITLE}</p>
                </div>
                <Button onClick={() => setCreateOpen(true)}>
                    <PlusIcon />
                    {LABELS.RESOURCES.CREATE}
                </Button>
            </div>

            <FilterChipGroup
                chips={FILTER_CHIPS}
                activeId={activeFilterId}
                onChange={(id) => {
                    setActiveFilterId(id);
                    // A cursor minted under one sort/filter has no meaning under
                    // another — start a fresh page whenever the active filter changes.
                    reset();
                }}
            />

            <DataTable
                columns={columns}
                data={data?.items ?? []}
                isLoading={isLoading}
                isError={isError}
                onRetry={() => void refetch()}
                emptyMessage={LABELS.RESOURCES.EMPTY}
                onRowClick={(resource) => void navigate(buildRoute.resourceDetail(resource.id))}
                pagination={{
                    canGoPrevious,
                    canGoNext: Boolean(data?.nextCursor),
                    onPrevious: goPrevious,
                    onNext: () => goNext(data?.nextCursor),
                    isFetching,
                }}
            />

            <ResourceFormDialog
                open={isCreateOpen}
                onOpenChange={(open) => {
                    setCreateOpen(open);
                    // A new row may land on page one, so paging restarts.
                    if (!open) reset();
                }}
            />

            <ConfirmDialog
                open={Boolean(pendingDelete)}
                onOpenChange={(open) => !open && setPendingDelete(null)}
                title={interpolate(LABELS.RESOURCES.DELETE_TITLE, { name: pendingDelete?.name ?? '' })}
                body={LABELS.RESOURCES.DELETE_BODY}
                confirmLabel={LABELS.COMMON.DELETE}
                isPending={isDeleting}
                onConfirm={() => {
                    if (!pendingDelete) return;
                    deleteResource(pendingDelete.id, { onSettled: () => setPendingDelete(null) });
                }}
            />
        </div>
    );
}
