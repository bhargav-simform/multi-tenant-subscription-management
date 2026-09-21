import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { PAGE_SIZE, STALE_TIME } from '@/constants/common';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { auditApi } from '@/services/audit/auditApi';

/**
 * The organisation's own trail. Onboarding, plan-limit rejections and any
 * cross-tenant access attempt land here — this is the structured trace you would
 * actually use to detect a leak in production, not reconstruct one afterwards.
 *
 * `eventType`, when set, is an exact-match filter applied server-side (never a
 * client-side filter over one already-loaded page) — this list is keyset
 * paginated, so filtering only the current page would silently hide matches
 * sitting on pages the caller hasn't fetched yet.
 */
export const useAuditEvents = (cursor?: string, limit: number = PAGE_SIZE.DEFAULT, eventType?: string) =>
    useQuery({
        queryKey: QUERY_KEYS.AUDIT.LIST(cursor, limit, eventType),
        queryFn: () => auditApi.list({ ...(cursor ? { cursor } : {}), limit, ...(eventType ? { eventType } : {}) }),
        staleTime: STALE_TIME.THIRTY_SECONDS,
        placeholderData: keepPreviousData,
    });
