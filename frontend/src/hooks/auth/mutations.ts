import { useMutation } from '@tanstack/react-query';

import { authApi } from '@/services/auth/authApi';
import { useAuth } from '@/contexts/useAuth';
import type { AcceptInvitationRequest, LoginRequest, SignupRequest } from '@/types/api';

/** Errors are surfaced inline on the form, not as a toast — the field is right there. */
export const useLogin = () => {
    const { login } = useAuth();
    return useMutation({
        mutationFn: (payload: LoginRequest) => login(payload),
    });
};

export const useLogout = () => {
    const { logout } = useAuth();
    return useMutation({ mutationFn: () => logout() });
};

export const useSignup = () =>
    useMutation({
        mutationFn: (payload: SignupRequest) => authApi.signup(payload),
    });

export const useAcceptInvitation = () =>
    useMutation({
        mutationFn: ({ token, payload }: { token: string; payload: AcceptInvitationRequest }) =>
            authApi.acceptInvitation(token, payload),
    });
