import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { LABELS } from '@/constants/labels';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { showMutationError } from '@/hooks/usePlanLimitError';
import { interpolate } from '@/lib/utils';
import { usersApi } from '@/services/users/usersApi';
import type { InviteUserRequest } from '@/types/api';

/**
 * Invalidates the subscription alongside the user list on every seat-affecting
 * change. A seat count that lags behind the table is how a user comes to believe
 * they have room they do not have, and then meets a 409 they cannot explain.
 */
const useSeatAffectingInvalidation = () => {
    const queryClient = useQueryClient();
    return () => {
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.USERS.ALL });
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.SUBSCRIPTION.ALL });
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.DASHBOARD.ROOT });
    };
};

/** THE seat-limit path. Its 409 message is shown verbatim (R6). */
export const useInviteUser = () => {
    const invalidate = useSeatAffectingInvalidation();
    return useMutation({
        mutationFn: (payload: InviteUserRequest) => usersApi.invite(payload),
        onSuccess: (_data, variables) => {
            invalidate();
            toast.success(interpolate(LABELS.USERS.INVITE_SUCCESS, { email: variables.email }));
        },
        onError: (error) => showMutationError(error),
    });
};

export const useUpdateUserRole = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, role }: { id: string; role: string }) => usersApi.updateRole(id, { role }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.USERS.ALL });
            toast.success(LABELS.USERS.ROLE_UPDATED);
        },
        onError: (error) => showMutationError(error),
    });
};

export const useRemoveUser = () => {
    const invalidate = useSeatAffectingInvalidation();
    return useMutation({
        mutationFn: (id: string) => usersApi.remove(id),
        onSuccess: () => {
            invalidate();
            toast.success(LABELS.USERS.REMOVED);
        },
        onError: (error) => showMutationError(error),
    });
};

export const useRevokeInvitation = () => {
    const invalidate = useSeatAffectingInvalidation();
    return useMutation({
        mutationFn: (invitationId: string) => usersApi.revokeInvitation(invitationId),
        onSuccess: () => invalidate(),
        onError: (error) => showMutationError(error),
    });
};
