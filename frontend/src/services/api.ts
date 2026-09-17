import axios, { type AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import { toast } from 'sonner';

import { ENDPOINTS } from '@/constants/endpoints';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { API_BASE_URL } from '@/lib/env';

import { tokenStore } from './tokenStore';

let unauthorizedHandler: (() => void) | null = null;
let redirectingToLogin = false;
/** The single in-flight refresh. Concurrent 401s all await this one promise. */
let refreshPromise: Promise<string | null> | null = null;

/** Lets AuthContext clear its own state when the interceptor gives up on the session. */
export const setUnauthorizedHandler = (handler: (() => void) | null) => {
    unauthorizedHandler = handler;
};

function redirectToLogin() {
    if (redirectingToLogin) return;
    redirectingToLogin = true;
    tokenStore.clear();
    unauthorizedHandler?.();
    globalThis.location.href = ROUTES.LOGIN;
}

function handleNetworkError() {
    if (redirectingToLogin) return;
    // A stable id collapses concurrent failures (parallel bootstrap requests) into
    // one toast instead of stacking one per failed request.
    toast.error(LABELS.COMMON.NETWORK_ERROR, { id: 'network-error' });
}

const api = axios.create({
    baseURL: API_BASE_URL,
    timeout: 30_000,
});

/** A promise that never settles — used while a hard navigation to /login is in flight, so React Query never renders an error state first. */
const pendingForever = <T,>(): Promise<T> =>
    new Promise<T>(() => {
        /* intentionally never settles — the page is navigating away */
    });

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const token = tokenStore.getAccessToken();
    if (token) config.headers.set('Authorization', `Bearer ${token}`);
    return config;
});

interface ApiErrorBody {
    message?: string | string[];
    error?: string;
    statusCode?: number;
}

type RetriableConfig = AxiosRequestConfig & { _retry?: boolean };

/**
 * Exchanges the stored refresh token for a new pair.
 *
 * Uses a BARE axios call, not `api`: going through the instance would re-enter
 * this same interceptor on failure and recurse. auth-service rotates the refresh
 * token on every use (single-use, with theft detection), so the new one must be
 * stored or the next refresh fails.
 */
async function performRefresh(): Promise<string | null> {
    const refreshToken = tokenStore.getRefreshToken();
    if (!refreshToken) return null;

    const { data } = await axios.post<{ accessToken: string; refreshToken: string }>(
        `${API_BASE_URL}${ENDPOINTS.AUTH.REFRESH}`,
        { refreshToken },
        { timeout: 30_000 },
    );
    tokenStore.set(data.accessToken, data.refreshToken);
    return data.accessToken;
}

/**
 * Refreshes once and replays the original request.
 *
 * Every concurrent 401 shares the ONE `refreshPromise`. Without that, a screen
 * firing four parallel queries would send four refreshes; since each rotation
 * invalidates the previous token, three of them would fail and log the user out
 * during ordinary use.
 */
function handleUnauthorized(error: AxiosError<ApiErrorBody>, isRefreshCall: boolean) {
    const originalRequest = error.config as RetriableConfig | undefined;

    if (!originalRequest || isRefreshCall || originalRequest._retry || !tokenStore.getRefreshToken()) {
        redirectToLogin();
        return pendingForever();
    }

    originalRequest._retry = true;
    refreshPromise ??= performRefresh().finally(() => {
        refreshPromise = null;
    });

    return refreshPromise
        .then((token) => {
            if (!token) {
                redirectToLogin();
                return pendingForever();
            }
            return api(originalRequest);
        })
        .catch(() => {
            redirectToLogin();
            return pendingForever();
        });
}

api.interceptors.response.use(
    (response) => response,
    (error: AxiosError<ApiErrorBody>) => {
        // No response at all — the gateway is unreachable.
        if (!error.response) {
            handleNetworkError();
            return Promise.reject(error);
        }

        if (error.response.status === 401) {
            const isRefreshCall = error.config?.url?.includes(ENDPOINTS.AUTH.REFRESH) ?? false;
            return handleUnauthorized(error, isRefreshCall);
        }

        // Everything else — 403, 404, 409 (plan limits), 422, 5xx — is left for the
        // calling hook. A 404 in particular is load-bearing: it is what a request for
        // another organisation's resource by id looks like, and swallowing it here
        // would hide the single most important behaviour in this system.
        return Promise.reject(error);
    },
);

export default api;
