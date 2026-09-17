import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { PAGE_SIZE, QUERY_META, STALE_TIME } from '@/constants/common';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { resourcesApi } from '@/services/resources/resourcesApi';

export const useResources = (cursor?: string, limit: number = PAGE_SIZE.DEFAULT) =>
    useQuery({
        queryKey: QUERY_KEYS.RESOURCES.LIST(cursor, limit),
        queryFn: () => resourcesApi.list({ ...(cursor ? { cursor } : {}), limit }),
        staleTime: STALE_TIME.ONE_MINUTE,
        placeholderData: keepPreviousData,
    });

/**
 * H1 — the sharpest cross-tenant case in the system.
 *
 * Given a valid-looking id belonging to another organisation, this returns 404.
 * The client did nothing to earn that: row-level security removed the row before
 * resource-service's query ran. The error toast is suppressed because a 404 is a
 * correct answer here, and retry is off because the answer will not change.
 */
export const useResource = (id: string | undefined) =>
    useQuery({
        queryKey: QUERY_KEYS.RESOURCES.DETAIL(id ?? ''),
        queryFn: () => resourcesApi.getById(id!),
        enabled: Boolean(id),
        staleTime: STALE_TIME.ONE_MINUTE,
        retry: false,
        meta: { [QUERY_META.SUPPRESS_ERROR_TOAST]: true },
    });
