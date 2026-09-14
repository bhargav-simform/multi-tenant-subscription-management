/**
 * Every table in the system must appear in exactly one of these lists (§13.8
 * "table classification test"). A table in neither fails the build. This is the
 * automated backstop for §13.7 row 7 (a lookup table misclassified as global when
 * it actually holds tenant data).
 *
 * Update this file in the SAME migration/PR that creates a new table.
 */
export const GLOBAL_TABLES = ['plans'] as const;

export const TENANT_TABLES = [
  'users',
  'invitations',
  'subscriptions',
  'subscription_history',
  'resources',
  'plan_limit_cache',
  'audit_events',
  'security_events',
] as const;

export type GlobalTable = (typeof GLOBAL_TABLES)[number];
export type TenantTable = (typeof TENANT_TABLES)[number];
