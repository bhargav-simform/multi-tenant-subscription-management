import { USAGE_THRESHOLD } from '@/constants/plan';

export type MeterTone = 'safe' | 'warn' | 'full';

/**
 * `max` of 0 would divide by zero; an unlimited-looking plan is shown as full
 * rather than as a silently empty bar.
 */
export const resolveRatio = (used: number, max: number): number => {
    if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return 1;
    return Math.max(0, used / max);
};

export const resolveTone = (ratio: number): MeterTone => {
    if (ratio >= USAGE_THRESHOLD.FULL) return 'full';
    if (ratio >= USAGE_THRESHOLD.WARN) return 'warn';
    return 'safe';
};
