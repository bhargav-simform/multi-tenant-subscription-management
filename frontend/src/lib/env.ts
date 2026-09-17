type EnvVariables = {
    VITE_API_BASE_URL?: string;
    DEV?: boolean;
};

const getEnv = (): EnvVariables => {
    try {
        return (import.meta.env as EnvVariables | undefined) ?? {};
    } catch {
        return {};
    }
};

const env = getEnv();

/** Defaults to the Vite dev proxy, so a fresh clone runs with no .env at all. */
export const API_BASE_URL = env.VITE_API_BASE_URL?.trim() || '/api';
export const IS_DEV = Boolean(env.DEV);
