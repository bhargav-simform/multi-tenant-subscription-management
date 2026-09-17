import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { PAGE_SIZE, STALE_TIME } from '@/constants/common';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { auditApi } from '@/services/audit/auditApi';

/**
 * The organisation's own trail. Onboarding, plan-limit rejections and any
 * cross-tenant access attempt land here — this is the structured trace you would
 * actually use to detect a leak in production, not reconstruct one afterwards.
 */
export const useAuditEvents = (cursor?: string, limit: number = PAGE_SIZE.DEFAULT) =>
    useQuery({
        queryKey: QUERY_KEYS.AUDIT.LIST(cursor, limit),
        queryFn: () => auditApi.list({ ...(cursor ? { cursor } : {}), limit }),
        staleTime: STALE_TIME.THIRTY_SECONDS,
        placeholderData: keepPreviousData,
    });
