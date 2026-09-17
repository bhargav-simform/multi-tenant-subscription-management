/** Plan codes exactly as subscription-service's PlanCode enum emits them. */
export const PLAN_CODE = {
    FREE: 'free',
    PRO: 'pro',
    ENTERPRISE: 'enterprise',
} as const;

/** Presentation order for the plan catalogue, cheapest first. */
export const PLAN_ORDER: string[] = [PLAN_CODE.FREE, PLAN_CODE.PRO, PLAN_CODE.ENTERPRISE];

/**
 * When a usage meter changes colour. These are DISPLAY thresholds only — the
 * server refuses the action, and it refuses it at 100%, not at 80%. Showing a
 * meter in amber is a courtesy, never a control.
 */
export const USAGE_THRESHOLD = {
    /** At or above this fraction, the meter turns amber. */
    WARN: 0.8,
    /** At or above this fraction, the meter turns red. */
    FULL: 1,
} as const;

/**
 * The error code subscription-service and user-service return when an action
 * would breach a plan limit. Its `message` is written to be shown to a human
 * verbatim — replacing it with a generic string defeats requirement R6.
 */
export const PLAN_LIMIT_EXCEEDED = 'PLAN_LIMIT_EXCEEDED';
