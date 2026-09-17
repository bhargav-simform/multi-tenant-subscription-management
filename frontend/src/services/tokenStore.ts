/**
 * Where the two tokens live.
 *
 * The access token is held in MEMORY only. It is the credential that actually
 * opens tenant data, it is short-lived (15 minutes), and keeping it out of any
 * persistent store means injected script cannot read it back later.
 *
 * The refresh token is held in sessionStorage. This is a DOCUMENTED TRADE-OFF,
 * not an oversight: the backend returns the refresh token in the login response
 * body rather than setting an httpOnly cookie, so the SPA has to put it
 * somewhere to survive a page reload. sessionStorage scopes it to the tab and
 * clears on close, which is the best available option given that contract — but
 * a token readable by JavaScript is readable by XSS.
 *
 * The fix is a backend change, not a frontend one: have api-gateway set the
 * refresh token as an httpOnly, SameSite=Strict cookie on login and read it from
 * the cookie on refresh. At that point this module keeps only the access token
 * and `refreshToken` disappears entirely. Nothing else in the app reads storage
 * directly, so that change is contained to this file and `authApi`.
 */
const REFRESH_TOKEN_KEY = 'tp.refreshToken';

let accessToken: string | null = null;

export const tokenStore = {
    getAccessToken: (): string | null => accessToken,

    setAccessToken: (token: string | null): void => {
        accessToken = token;
    },

    getRefreshToken: (): string | null => {
        try {
            return sessionStorage.getItem(REFRESH_TOKEN_KEY);
        } catch {
            // Private mode / storage disabled — the session simply won't survive a reload.
            return null;
        }
    },

    setRefreshToken: (token: string | null): void => {
        try {
            if (token) sessionStorage.setItem(REFRESH_TOKEN_KEY, token);
            else sessionStorage.removeItem(REFRESH_TOKEN_KEY);
        } catch {
            // Non-fatal: the in-memory access token still works for this page view.
        }
    },

    set: (access: string | null, refresh: string | null): void => {
        tokenStore.setAccessToken(access);
        tokenStore.setRefreshToken(refresh);
    },

    clear: (): void => {
        accessToken = null;
        tokenStore.setRefreshToken(null);
    },
};
