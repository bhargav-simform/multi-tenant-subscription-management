import type { AxiosError } from 'axios';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/**
 * class-validator's ValidationPipe (used by every DTO across the backend) sends
 * failed-field errors as an array of `{ field, message }` objects, not an array
 * of plain strings — the same shape SimERP's own axios interceptor normalizes.
 * A single-string `message` is what a hand-written throw (e.g. a 409 plan-limit
 * refusal) looks like.
 */
interface ApiErrorBody {
    message?: string | Array<{ field?: string; message?: string }>;
    error?: string;
    statusCode?: number;
}

/**
 * The server's own message, when it has one worth showing.
 *
 * This matters more here than in most apps: subscription-service and user-service
 * write plan-limit messages intended to be read by a human ("Inviting this user
 * would exceed the Free plan's limit of 3 seats"). Requirement R6 asks for a clear,
 * specific refusal — so a specific server message always wins over the fallback.
 */
export const getErrorMessage = (error: unknown, fallback: string): string => {
    const axiosError = error as AxiosError<ApiErrorBody>;
    const message = axiosError?.response?.data?.message;
    if (typeof message === 'string' && message) return message;
    if (Array.isArray(message) && message.length > 0) {
        const joined = message
            .map((entry) => (typeof entry?.message === 'string' ? entry.message : ''))
            .filter(Boolean)
            .join(', ');
        if (joined) return joined;
    }
    return fallback;
};

/** The structured `error` code, e.g. PLAN_LIMIT_EXCEEDED. */
export const getErrorCode = (error: unknown): string | undefined =>
    (error as AxiosError<ApiErrorBody>)?.response?.data?.error;

export const getErrorStatus = (error: unknown): number | undefined =>
    (error as AxiosError)?.response?.status;

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Storage limits are quoted in bytes by the API; humans do not read bytes. */
export const formatBytes = (bytes: number | null | undefined): string => {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
    if (bytes <= 0) return '0 B';

    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
    const value = bytes / 1024 ** exponent;
    // Whole numbers for bytes; one decimal above that, so "1.5 GB" not "1.50000 GB".
    const formatted = exponent === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1);
    return `${formatted} ${BYTE_UNITS[exponent]}`;
};

export const formatDateTime = (value: string | Date | null | undefined): string => {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
};

export const formatDate = (value: string | Date | null | undefined): string => {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' }).format(date);
};

const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
];

/** Coarse relative time ("4 hours ago") — no library, minute-granularity is enough for activity subtitles. */
export const formatRelativeTime = (value: string | Date | null | undefined): string => {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';

    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

    for (const [unit, unitSeconds] of RELATIVE_TIME_UNITS) {
        if (Math.abs(seconds) >= unitSeconds) return formatter.format(Math.round(seconds / unitSeconds), unit);
    }
    return formatter.format(Math.round(seconds / 60), 'minute');
};

export const getInitials = (first?: string | null, last?: string | null): string => {
    const a = first?.trim()?.[0] ?? '';
    const b = last?.trim()?.[0] ?? '';
    return (a + b).toUpperCase() || '?';
};

export const fullName = (first?: string | null, last?: string | null): string =>
    [first, last].filter(Boolean).join(' ').trim();

/** Fills `{placeholder}` tokens in a LABELS string. */
export const interpolate = (template: string, values: Record<string, string | number>): string =>
    Object.entries(values).reduce<string>(
        (acc, [key, value]) => acc.replaceAll(`{${key}}`, String(value)),
        template,
    );

/**
 * A signup needs a client-generated idempotency key matching /^[a-zA-Z0-9-]{8,128}$/.
 * It is generated ONCE per form mount and reused across retries — that is the whole
 * point: a retry after a partial failure must carry the same key so tenant-service
 * recognises it as the same attempt rather than creating a second organisation.
 */
export const generateIdempotencyKey = (): string => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};
