import { useQuery } from '@tanstack/react-query';

import { STALE_TIME } from '@/constants/common';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { dashboardApi } from '@/services/dashboard/dashboardApi';

/** One request, not a waterfall — the gateway's single aggregate route. */
export const useDashboard = () =>
    useQuery({
        queryKey: QUERY_KEYS.DASHBOARD.ROOT,
        queryFn: () => dashboardApi.get(),
        staleTime: STALE_TIME.ONE_MINUTE,
    });
