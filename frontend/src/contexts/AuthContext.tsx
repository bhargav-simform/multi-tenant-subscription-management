import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { PLATFORM_ADMIN_ROLE, USER_ROLE } from '@/constants/common';
import { authApi } from '@/services/auth/authApi';
import { setUnauthorizedHandler } from '@/services/api';
import { tokenStore } from '@/services/tokenStore';
import type { LoginRequest, SessionUser } from '@/types/api';

export interface AuthContextValue {
    user: SessionUser | null;
    isAuthenticated: boolean;
    /** True only while the initial session restore is in flight. */
    isBootstrapping: boolean;
    isPlatformAdmin: boolean;
    isOrgAdmin: boolean;
    login: (payload: LoginRequest) => Promise<SessionUser>;
    logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const SESSION_USER_KEY = 'tp.sessionUser';

/**
 * The identity that came back from login, cached so a reload does not blank the
 * shell before the first request resolves. It is a CONVENIENCE COPY and nothing
 * more: it decides what to render, never what is permitted. Every real decision
 * is made by the server against the signed token, so a user who edits this value
 * in devtools changes which menu items they see and nothing else — every request
 * they then make is still scoped to their own organisation by RLS.
 */
const readCachedUser = (): SessionUser | null => {
    try {
        const raw = sessionStorage.getItem(SESSION_USER_KEY);
        return raw ? (JSON.parse(raw) as SessionUser) : null;
    } catch {
        return null;
    }
};

const writeCachedUser = (user: SessionUser | null): void => {
    try {
        if (user) sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
        else sessionStorage.removeItem(SESSION_USER_KEY);
    } catch {
        // Non-fatal — the app works, it just re-renders the shell on reload.
    }
};

/**
 * A platform admin is a credentials row with a NULL organizationId. That single
 * column is what makes AuthService.resolveRoles return PLATFORM_ADMIN, so the SPA
 * derives the flag exactly the same way rather than inventing a role string.
 */
const derivePlatformAdmin = (user: SessionUser | null): boolean => {
    if (!user) return false;
    if (user.roles.includes(PLATFORM_ADMIN_ROLE)) return true;
    return user.organizationId === null;
};

/**
 * Restoring a session is a synchronous read of sessionStorage — no async work,
 * no subscription — so it belongs in `useState`'s lazy initializer, computed
 * once for the first render, rather than in an effect that would set state
 * again immediately after mount. The access token itself lives in memory and
 * is gone after F5; it is re-minted from the refresh token by the first
 * request's 401 → refresh → replay path in the axios interceptor.
 */
const readInitialUser = (): SessionUser | null => {
    const cached = readCachedUser();
    if (cached && tokenStore.getRefreshToken()) return cached;

    // A cached user with no matching refresh token is a stale/invalid session —
    // clear the leftover storage key now rather than carrying it forward. This
    // writes to sessionStorage only; it is not React state, so doing it here
    // (during the lazy initializer, before the first render) is fine, unlike a
    // `setState` call in an effect body.
    if (cached) writeCachedUser(null);
    return null;
};

export function AuthProvider({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient();
    const [user, setUser] = useState<SessionUser | null>(readInitialUser);
    // Bootstrap is now synchronous — resolved before the initial render — but
    // the flag is kept (starting `false`) so callers of `isBootstrapping` do
    // not have to change if a real async check is added here later.
    const [isBootstrapping] = useState(false);

    /** Clears every trace of the previous session — tokens, identity and cache. */
    const clearSession = useCallback(() => {
        tokenStore.clear();
        writeCachedUser(null);
        setUser(null);
        // The cache is tenant-agnostic by design, so it MUST be emptied on a user
        // change: without this, the next user to sign in on this tab would briefly
        // read the previous user's cached lists.
        queryClient.clear();
    }, [queryClient]);

    // When the interceptor gives up on a session, the context must agree.
    useEffect(() => {
        setUnauthorizedHandler(() => {
            writeCachedUser(null);
            setUser(null);
            queryClient.clear();
        });
        return () => setUnauthorizedHandler(null);
    }, [queryClient]);

    const login = useCallback(
        async (payload: LoginRequest): Promise<SessionUser> => {
            // Anything cached under the previous identity goes before the new one lands.
            queryClient.clear();
            const response = await authApi.login(payload);
            writeCachedUser(response.user);
            setUser(response.user);
            return response.user;
        },
        [queryClient],
    );

    const logout = useCallback(async (): Promise<void> => {
        try {
            await authApi.logout();
        } finally {
            clearSession();
        }
    }, [clearSession]);

    const value = useMemo<AuthContextValue>(() => {
        const isPlatformAdmin = derivePlatformAdmin(user);
        return {
            user,
            isAuthenticated: Boolean(user),
            isBootstrapping,
            isPlatformAdmin,
            // A platform admin is not an org admin: they have no organisation at all.
            isOrgAdmin: !isPlatformAdmin && (user?.roles.includes(USER_ROLE.ORG_ADMIN) ?? false),
            login,
            logout,
        };
    }, [user, isBootstrapping, login, logout]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
