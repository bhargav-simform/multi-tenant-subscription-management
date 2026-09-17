import axios from 'axios';

import { ENDPOINTS } from '@/constants/endpoints';
import { API_BASE_URL } from '@/lib/env';
import api from '@/services/api';
import { tokenStore } from '@/services/tokenStore';
import type {
    AcceptInvitationRequest,
    LoginRequest,
    LoginResponse,
    SignupRequest,
    SignupResponse,
    User,
} from '@/types/api';

export const authApi = {
    /**
     * Stores both tokens as a side effect: every other request in the app depends
     * on the access token being in place the moment login resolves, and leaving
     * that to the caller invites a screen that renders before it is set.
     */
    login: async (payload: LoginRequest): Promise<LoginResponse> => {
        // A bare axios call, not `api`: a failed login is a 401, and going through
        // the instance would send the interceptor off to refresh a session that
        // does not exist yet and redirect to /login mid-login.
        const { data } = await axios.post<LoginResponse>(`${API_BASE_URL}${ENDPOINTS.AUTH.LOGIN}`, payload, {
            timeout: 30_000,
        });
        tokenStore.set(data.accessToken, data.refreshToken);
        return data;
    },

    /**
     * Logout is authenticated on purpose: the gateway denylists the caller's own
     * access-token `jti`, and a jti is only trustworthy out of a verified token.
     * Tokens are cleared even when the call fails — a user who clicked sign out is
     * signed out locally regardless of what the network did.
     */
    logout: async (): Promise<void> => {
        const refreshToken = tokenStore.getRefreshToken();
        try {
            if (refreshToken) await api.post(ENDPOINTS.AUTH.LOGOUT, { refreshToken });
        } finally {
            tokenStore.clear();
        }
    },

    /** Public — the one anonymous write in the system. */
    signup: async (payload: SignupRequest): Promise<SignupResponse> => {
        const { data } = await axios.post<SignupResponse>(`${API_BASE_URL}${ENDPOINTS.ONBOARDING.SIGNUP}`, payload, {
            timeout: 30_000,
        });
        return data;
    },

    /** Public — the invitation token IS the credential, so no session is required. */
    acceptInvitation: async (token: string, payload: AcceptInvitationRequest): Promise<User> => {
        const { data } = await axios.post<User>(
            `${API_BASE_URL}${ENDPOINTS.INVITATIONS.ACCEPT(token)}`,
            payload,
            { timeout: 30_000 },
        );
        return data;
    },
};
