import { useQuery } from '@tanstack/react-query';

import { STALE_TIME } from '@/constants/common';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { subscriptionApi } from '@/services/subscription/subscriptionApi';

export const useCurrentSubscription = () =>
    useQuery({
        queryKey: QUERY_KEYS.SUBSCRIPTION.CURRENT,
        queryFn: () => subscriptionApi.getCurrent(),
        staleTime: STALE_TIME.THIRTY_SECONDS,
    });

/** The catalogue is global and effectively immutable — cached for an hour. */
export const usePlans = () =>
    useQuery({
        queryKey: QUERY_KEYS.SUBSCRIPTION.PLANS,
        queryFn: () => subscriptionApi.listPlans(),
        staleTime: STALE_TIME.ONE_HOUR,
    });
