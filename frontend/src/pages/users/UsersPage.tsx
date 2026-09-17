import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { PlusIcon, Trash2Icon } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DataTable, useCursorPagination } from '@/components/common/data-table';
import { StatusBadge, type BadgeTone } from '@/components/common/status-badge';
import { UsageMeter } from '@/components/common/usage-meter';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { USER_ROLE, USER_STATUS } from '@/constants/common';
import { LABELS } from '@/constants/labels';
import { useCurrentSubscription } from '@/hooks/subscription/queries';
import { useRemoveUser, useUpdateUserRole } from '@/hooks/users/mutations';
import { useUsers } from '@/hooks/users/queries';
import { fullName, interpolate } from '@/lib/utils';
import type { User } from '@/types/api';

import { InviteUserDialog } from './InviteUserDialog';

const STATUS_TONE: Record<string, BadgeTone> = {
    [USER_STATUS.ACTIVE]: 'green',
    [USER_STATUS.INVITED]: 'amber',
    [USER_STATUS.SUSPENDED]: 'red',
};

const STATUS_LABEL: Record<string, string> = {
    [USER_STATUS.ACTIVE]: LABELS.USERS.STATUS_ACTIVE,
    [USER_STATUS.INVITED]: LABELS.USERS.STATUS_INVITED,
    [USER_STATUS.SUSPENDED]: LABELS.USERS.STATUS_SUSPENDED,
};

/**
 * Org-admin user management.
 *
 * Every mutation here can only ever affect a user inside the caller's own
 * organisation — including an attempt aimed at a user id from another one, which
 * comes back 404 for the same reason a foreign resource does. The page does not
 * need to check that, and deliberately does not try.
 */
export default function UsersPage() {
    const { cursor, canGoPrevious, goNext, goPrevious, reset } = useCursorPagination();
    const { data, isLoading, isError, isFetching, refetch } = useUsers(cursor);
    const { data: subscription } = useCurrentSubscription();
    const { mutate: updateRole } = useUpdateUserRole();
    const { mutate: removeUser, isPending: isRemoving } = useRemoveUser();

    const [isInviteOpen, setInviteOpen] = useState(false);
    const [pendingRemove, setPendingRemove] = useState<User | null>(null);

    const columns = useMemo<ColumnDef<User>[]>(
        () => [
            {
                accessorKey: 'firstName',
                header: LABELS.USERS.NAME,
                cell: ({ row }) => {
                    const name = fullName(row.original.firstName, row.original.lastName);
                    return <span className="font-medium">{name || LABELS.COMMON.NO_DATA}</span>;
                },
            },
            { accessorKey: 'email', header: LABELS.USERS.EMAIL },
            {
                accessorKey: 'role',
                header: LABELS.USERS.ROLE,
                cell: ({ row }) => (
                    <Select
                        value={row.original.role}
                        onValueChange={(role) => updateRole({ id: row.original.id, role })}
                    >
                        <SelectTrigger size="sm" className="w-36" aria-label={LABELS.USERS.CHANGE_ROLE}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={USER_ROLE.ORG_MEMBER}>{LABELS.USERS.ROLE_ORG_MEMBER}</SelectItem>
                            <SelectItem value={USER_ROLE.ORG_ADMIN}>{LABELS.USERS.ROLE_ORG_ADMIN}</SelectItem>
                        </SelectContent>
                    </Select>
                ),
            },
            {
                accessorKey: 'status',
                header: LABELS.USERS.STATUS,
                cell: ({ row }) => (
                    <StatusBadge tone={STATUS_TONE[row.original.status] ?? 'slate'}>
                        {STATUS_LABEL[row.original.status] ?? row.original.status}
                    </StatusBadge>
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
                        aria-label={interpolate(LABELS.USERS.REMOVE_TITLE, {
                            name: fullName(row.original.firstName, row.original.lastName) || row.original.email,
                        })}
                        onClick={() => setPendingRemove(row.original)}
                    >
                        <Trash2Icon className="text-muted-foreground" />
                    </Button>
                ),
            },
        ],
        [updateRole],
    );

    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                    <h1>{LABELS.USERS.TITLE}</h1>
                    <p className="text-sm text-muted-foreground">{LABELS.USERS.SUBTITLE}</p>
                </div>
                <Button onClick={() => setInviteOpen(true)}>
                    <PlusIcon />
                    {LABELS.USERS.INVITE}
                </Button>
            </div>

            {subscription && (
                <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
                    <UsageMeter
                        label={LABELS.PLAN.SEATS_LABEL}
                        used={subscription.usedSeats}
                        max={subscription.maxSeats}
                    />
                </div>
            )}

            <DataTable
                columns={columns}
                data={data?.items ?? []}
                isLoading={isLoading}
                isError={isError}
                onRetry={() => void refetch()}
                emptyMessage={LABELS.USERS.EMPTY}
                pagination={{
                    canGoPrevious,
                    canGoNext: Boolean(data?.nextCursor),
                    onPrevious: goPrevious,
                    onNext: () => goNext(data?.nextCursor),
                    isFetching,
                }}
            />

            <InviteUserDialog
                open={isInviteOpen}
                onOpenChange={(open) => {
                    setInviteOpen(open);
                    if (!open) reset();
                }}
            />

            <ConfirmDialog
                open={Boolean(pendingRemove)}
                onOpenChange={(open) => !open && setPendingRemove(null)}
                title={interpolate(LABELS.USERS.REMOVE_TITLE, {
                    name: pendingRemove ? fullName(pendingRemove.firstName, pendingRemove.lastName) || pendingRemove.email : '',
                })}
                body={LABELS.USERS.REMOVE_BODY}
                confirmLabel={LABELS.USERS.REMOVE}
                isPending={isRemoving}
                onConfirm={() => {
                    if (!pendingRemove) return;
                    removeUser(pendingRemove.id, { onSettled: () => setPendingRemove(null) });
                }}
            />
        </div>
    );
}
