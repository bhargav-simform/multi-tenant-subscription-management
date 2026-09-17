import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { LABELS } from '@/constants/labels';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { showMutationError } from '@/hooks/usePlanLimitError';
import { resourcesApi } from '@/services/resources/resourcesApi';
import type { CreateResourceRequest } from '@/types/api';

/** Storage used changes with every create and delete, so the plan view follows along. */
const useStorageAffectingInvalidation = () => {
    const queryClient = useQueryClient();
    return () => {
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.RESOURCES.ALL });
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.SUBSCRIPTION.ALL });
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.DASHBOARD.ROOT });
    };
};

/** The storage-limit path. Its 409 message is shown verbatim (R6). */
export const useCreateResource = () => {
    const invalidate = useStorageAffectingInvalidation();
    return useMutation({
        mutationFn: (payload: CreateResourceRequest) => resourcesApi.create(payload),
        onSuccess: () => {
            invalidate();
            toast.success(LABELS.RESOURCES.CREATED);
        },
        onError: (error) => showMutationError(error),
    });
};

export const useDeleteResource = () => {
    const invalidate = useStorageAffectingInvalidation();
    return useMutation({
        mutationFn: (id: string) => resourcesApi.remove(id),
        onSuccess: () => {
            invalidate();
            toast.success(LABELS.RESOURCES.DELETED);
        },
        onError: (error) => showMutationError(error),
    });
};
