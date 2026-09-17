import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { PageEmptyState, PageErrorState, PageLoadingState } from '@/components/common/page-state';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LABELS } from '@/constants/labels';
import { cn } from '@/lib/utils';

export interface DataTableProps<TData, TValue> {
    columns: ColumnDef<TData, TValue>[];
    data: TData[];
    isLoading?: boolean;
    isError?: boolean;
    onRetry?: () => void;
    emptyMessage?: string;
    emptyAction?: React.ReactNode;
    onRowClick?: (row: TData) => void;
    /** Keyset pagination controls. Omit for a list that never pages. */
    pagination?: CursorPaginationProps;
    className?: string;
}

export interface CursorPaginationProps {
    canGoPrevious: boolean;
    canGoNext: boolean;
    onPrevious: () => void;
    onNext: () => void;
    isFetching?: boolean;
}

/**
 * Server-side keyset pagination only.
 *
 * TanStack Table is used headless, for column definitions and rendering — never
 * for paging, sorting or filtering. Those all happen on the server, because the
 * organisation list and each organisation's resource list have to stay usable as
 * they grow, and "load everything and filter in the browser" stops being viable
 * at exactly the scale this POC is meant to survive.
 */
export function DataTable<TData, TValue>({
    columns,
    data,
    isLoading,
    isError,
    onRetry,
    emptyMessage,
    emptyAction,
    onRowClick,
    pagination,
    className,
}: DataTableProps<TData, TValue>) {
    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        // Paging is the server's job; the table renders exactly the page it is given.
        manualPagination: true,
        manualSorting: true,
        manualFiltering: true,
    });

    if (isLoading) return <PageLoadingState />;
    if (isError) return <PageErrorState onRetry={onRetry} />;
    if (data.length === 0) return <PageEmptyState body={emptyMessage} action={emptyAction} />;

    return (
        <div className={cn('flex flex-col gap-3', className)}>
            <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
                <div className="overflow-x-auto">
                    <Table>
                        <TableHeader className="bg-table-header-bg">
                            {table.getHeaderGroups().map((headerGroup) => (
                                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                                    {headerGroup.headers.map((header) => (
                                        <TableHead
                                            key={header.id}
                                            style={header.column.columnDef.size ? { width: header.column.columnDef.size } : undefined}
                                            className="text-table-header-text"
                                        >
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(header.column.columnDef.header, header.getContext())}
                                        </TableHead>
                                    ))}
                                </TableRow>
                            ))}
                        </TableHeader>
                        <TableBody>
                            {table.getRowModel().rows.map((row) => (
                                <TableRow
                                    key={row.id}
                                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                                    // A clickable row is reachable by keyboard too, not only by mouse.
                                    tabIndex={onRowClick ? 0 : undefined}
                                    role={onRowClick ? 'button' : undefined}
                                    onKeyDown={
                                        onRowClick
                                            ? (event) => {
                                                  if (event.key === 'Enter' || event.key === ' ') {
                                                      event.preventDefault();
                                                      onRowClick(row.original);
                                                  }
                                              }
                                            : undefined
                                    }
                                    className={cn(onRowClick && 'cursor-pointer focus-visible:bg-accent focus-visible:outline-none')}
                                >
                                    {row.getVisibleCells().map((cell) => (
                                        <TableCell key={cell.id}>
                                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            </div>

            {pagination && <CursorPagination {...pagination} />}
        </div>
    );
}

/**
 * Previous/Next only, deliberately.
 *
 * Keyset pagination has no page numbers and no total count — that is the point.
 * Offering "page 7 of 40" would mean a COUNT over every row on every request,
 * which is the cost this pagination strategy exists to avoid.
 */
function CursorPagination({ canGoPrevious, canGoNext, onPrevious, onNext, isFetching }: CursorPaginationProps) {
    return (
        <div className="flex items-center justify-end gap-2">
            <Button
                variant="outline"
                size="sm"
                onClick={onPrevious}
                disabled={!canGoPrevious || isFetching}
                aria-label={LABELS.COMMON.PREVIOUS}
            >
                <ChevronLeftIcon />
                {LABELS.COMMON.PREVIOUS}
            </Button>
            <Button variant="outline" size="sm" onClick={onNext} disabled={!canGoNext || isFetching} aria-label={LABELS.COMMON.NEXT}>
                {LABELS.COMMON.NEXT}
                <ChevronRightIcon />
            </Button>
        </div>
    );
}
