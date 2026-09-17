import { describe, expect, it } from 'vitest';

import { formatBytes, generateIdempotencyKey, getErrorCode, getErrorMessage, interpolate } from '@/lib/utils';

describe('formatBytes', () => {
    it('renders whole bytes without a decimal', () => {
        expect(formatBytes(512)).toBe('512 B');
    });

    it('renders larger units with one decimal place', () => {
        expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('treats null/undefined/non-finite as no data', () => {
        expect(formatBytes(null)).toBe('—');
        expect(formatBytes(undefined)).toBe('—');
        expect(formatBytes(Number.NaN)).toBe('—');
    });

    it('never goes negative', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(-100)).toBe('0 B');
    });
});

describe('getErrorMessage / getErrorCode', () => {
    const fallback = 'fallback message';

    it('returns the server message verbatim when present (R6)', () => {
        const error = {
            response: { data: { message: 'Inviting this user would exceed the Free plan’s limit of 3 seats.' } },
        };
        expect(getErrorMessage(error, fallback)).toBe(
            'Inviting this user would exceed the Free plan’s limit of 3 seats.',
        );
    });

    it('joins an array of field errors into one string', () => {
        const error = { response: { data: { message: [{ message: 'a' }, { message: 'b' }] } } };
        expect(getErrorMessage(error, fallback)).toBe('a, b');
    });

    it('falls back when there is no server message', () => {
        expect(getErrorMessage({}, fallback)).toBe(fallback);
        expect(getErrorMessage(new Error('network down'), fallback)).toBe(fallback);
    });

    it('reads the structured error code', () => {
        const error = { response: { data: { error: 'PLAN_LIMIT_EXCEEDED' } } };
        expect(getErrorCode(error)).toBe('PLAN_LIMIT_EXCEEDED');
    });
});

describe('interpolate', () => {
    it('fills every placeholder token', () => {
        expect(interpolate('{used} of {max} seats used', { used: 3, max: 5 })).toBe('3 of 5 seats used');
    });
});

describe('generateIdempotencyKey', () => {
    it('matches tenant-service SignupDto’s pattern (/^[a-zA-Z0-9-]{8,128}$/)', () => {
        const key = generateIdempotencyKey();
        expect(key).toMatch(/^[a-zA-Z0-9-]{8,128}$/);
    });

    it('produces a different key on each call', () => {
        expect(generateIdempotencyKey()).not.toBe(generateIdempotencyKey());
    });
});
