import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { PAGE_SIZE, QUERY_META, STALE_TIME } from '@/constants/common';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { resourcesApi } from '@/services/resources/resourcesApi';
import type { ResourceSort } from '@/types/api';

/**
 * `sort`/`hasDescription` are real, server-side keyset-pagination-aware
 * params (resource-service's ListResourcesQueryDto) — never a client-side
 * filter over one already-fetched page. The caller MUST reset `cursor` to
 * undefined whenever sort/hasDescription changes, since a cursor minted under
 * one ordering has no meaning under another.
 */
export const useResources = (
    cursor?: string,
    limit: number = PAGE_SIZE.DEFAULT,
    sort?: ResourceSort,
    hasDescription?: 'true' | 'false',
) =>
    useQuery({
        queryKey: QUERY_KEYS.RESOURCES.LIST(cursor, limit, sort, hasDescription),
        queryFn: () =>
            resourcesApi.list({
                ...(cursor ? { cursor } : {}),
                limit,
                ...(sort ? { sort } : {}),
                ...(hasDescription ? { hasDescription } : {}),
            }),
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
