import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { PAGE_SIZE, QUERY_META, STALE_TIME } from '@/constants/common';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { usersApi } from '@/services/users/usersApi';

export const useUsers = (cursor?: string, limit: number = PAGE_SIZE.DEFAULT) =>
    useQuery({
        queryKey: QUERY_KEYS.USERS.LIST(cursor, limit),
        queryFn: () => usersApi.list({ ...(cursor ? { cursor } : {}), limit }),
        staleTime: STALE_TIME.ONE_MINUTE,
        // Keyset pages swap without the table collapsing to a spinner between them.
        placeholderData: keepPreviousData,
    });

/**
 * A 404 here is the expected answer for an id belonging to another organisation,
 * so the global error toast is suppressed and the page renders a not-found state
 * instead. Retrying would be pointless: RLS will filter the row out every time.
 */
export const useUser = (id: string | undefined) =>
    useQuery({
        queryKey: QUERY_KEYS.USERS.DETAIL(id ?? ''),
        queryFn: () => usersApi.getById(id!),
        enabled: Boolean(id),
        staleTime: STALE_TIME.ONE_MINUTE,
        retry: false,
        meta: { [QUERY_META.SUPPRESS_ERROR_TOAST]: true },
    });

/** Pending invitations for the Users page's merged view — small and unpaginated (capped by the seat limit). */
export const usePendingInvitations = () =>
    useQuery({
        queryKey: QUERY_KEYS.USERS.INVITATIONS,
        queryFn: () => usersApi.listInvitations(),
        staleTime: STALE_TIME.ONE_MINUTE,
    });
