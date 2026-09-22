import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { PageEmptyState, PageErrorState } from '@/components/common/page-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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
    /** Number of placeholder rows to render while `isLoading` is true. */
    skeletonRows?: number;
}

/** Staggered widths so skeleton cells don't read as one uniform grey bar. */
const SKELETON_WIDTHS = ['w-3/5', 'w-2/5', 'w-1/3', 'w-1/4', 'w-1/2'];

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
    skeletonRows = 5,
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

    if (isError) return <PageErrorState onRetry={onRetry} />;
    if (!isLoading && data.length === 0) return <PageEmptyState body={emptyMessage} action={emptyAction} />;

    const headerGroups = table.getHeaderGroups();
    const columnCount = headerGroups[0]?.headers.length ?? columns.length;

    return (
        <div className={cn('flex flex-col gap-3', className)}>
            <div className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-card">
                <div className="overflow-x-auto">
                    <Table>
                        <TableHeader className="bg-table-header-bg">
                            {headerGroups.map((headerGroup) => (
                                <TableRow key={headerGroup.id} className="border-b border-border hover:bg-transparent">
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
                            {isLoading
                                ? Array.from({ length: skeletonRows }, (_, rowIndex) => (
                                      <TableRow key={`skeleton-${rowIndex}`} className="hover:bg-transparent">
                                          {Array.from({ length: columnCount }, (_, colIndex) => (
                                              <TableCell key={colIndex}>
                                                  <Skeleton
                                                      className={cn('h-4', SKELETON_WIDTHS[colIndex % SKELETON_WIDTHS.length])}
                                                  />
                                              </TableCell>
                                          ))}
                                      </TableRow>
                                  ))
                                : table.getRowModel().rows.map((row) => (
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
                                          className={cn(
                                              'hover:bg-table-row-hover transition-colors',
                                              onRowClick && 'cursor-pointer focus-visible:bg-accent focus-visible:outline-none',
                                          )}
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

            {pagination && !isLoading && <CursorPagination {...pagination} />}
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
