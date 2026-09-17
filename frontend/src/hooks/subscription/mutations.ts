import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { LABELS } from '@/constants/labels';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { showMutationError } from '@/hooks/usePlanLimitError';
import { interpolate } from '@/lib/utils';
import { subscriptionApi } from '@/services/subscription/subscriptionApi';

/**
 * A downgrade is a limit path too: moving to a smaller plan while over its caps
 * is refused with the same specific 409 an over-limit invite gets.
 */
export const useChangePlan = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (planCode: string) => subscriptionApi.changePlan({ planCode }),
        onSuccess: (data) => {
            void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.SUBSCRIPTION.ALL });
            void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.DASHBOARD.ROOT });
            toast.success(interpolate(LABELS.PLAN.CHANGED, { plan: data.planName }));
        },
        onError: (error) => showMutationError(error),
    });
};
