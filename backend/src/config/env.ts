import { config as loadDotenv } from 'dotenv';

// Docker passes env via env_file; a local run picks up backend/.env, then the repo-root .env.
loadDotenv({ path: ['.env', '../.env'], quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * DATABASE_URL wins when set. Otherwise it is assembled from the same POSTGRES_* /
 * APP_DB_* variables docker/postgres/init.sh uses, so one .env drives both.
 */
export function buildDatabaseUrl(
  userVar: string,
  passwordVar: string,
  explicitVar: string,
): string {
  const explicit = process.env[explicitVar];
  if (explicit) return explicit;
  const user = encodeURIComponent(required(userVar));
  const password = encodeURIComponent(required(passwordVar));
  const host = optional('POSTGRES_HOST', 'localhost');
  const port = optional('POSTGRES_PORT', '5432');
  const db = optional('DB_NAME', 'app_db');
  return `postgresql://${user}:${password}@${host}:${port}/${db}`;
}

/**
 * Read lazily (getters), not captured at import time, so tests can set process.env
 * before the first access and so a missing variable fails where it is used.
 * Every "required" here was a ConfigService.getOrThrow() in the Nest services.
 */
export const env = {
  get nodeEnv(): string {
    return optional('NODE_ENV', 'development');
  },
  get port(): number {
    return Number(optional('PORT', '3000'));
  },
  get logLevel(): string | undefined {
    return process.env.LOG_LEVEL || undefined;
  },
  get databaseUrl(): string {
    return buildDatabaseUrl('APP_DB_USER', 'APP_DB_PASSWORD', 'DATABASE_URL');
  },
  get jwtSecret(): string {
    return required('JWT_SECRET');
  },
  get jwtAccessExpiresIn(): string {
    return optional('JWT_ACCESS_EXPIRES_IN', '15m');
  },
  get jwtRefreshExpiresIn(): string {
    return optional('JWT_REFRESH_EXPIRES_IN', '7d');
  },
  get corsOrigins(): string[] {
    return required('CORS_ORIGINS')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  },
  get throttleTtlMs(): number {
    return Number(required('THROTTLE_TTL_MS'));
  },
  get throttleLimit(): number {
    return Number(required('THROTTLE_LIMIT'));
  },
  get throttleStrictTtlMs(): number {
    return Number(required('THROTTLE_STRICT_TTL_MS'));
  },
  get throttleStrictLimit(): number {
    return Number(required('THROTTLE_STRICT_LIMIT'));
  },
};
