/**
 * Every table in the system must appear in exactly one of these lists (§13.8
 * "table classification test"). A table in neither fails the build. This is the
 * automated backstop for §13.7 row 7 (a lookup table misclassified as global when
 * it actually holds tenant data).
 *
 * Update this file in the SAME migration/PR that creates a new table.
 */
export const GLOBAL_TABLES = ['plans'] as const;

/**
 * The tenant REGISTRY, not tenant CONTENT (§8.3). Deliberately not RLS-protected —
 * a platform admin legitimately reads these directly for the org list (§13.6), and
 * RLS would block that legitimate read. This is what makes "platform admin sees
 * orgs but not content" structural: these are the only two tables a platform
 * admin's queries ever touch, and neither can hold organisation content by
 * definition (§8.3's schema). A table belongs here ONLY if it is part of the
 * registry/orchestration layer itself — never for "it's inconvenient to scope".
 */
export const REGISTRY_TABLES = ['organizations', 'onboarding_sagas'] as const;

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
export type RegistryTable = (typeof REGISTRY_TABLES)[number];
export type TenantTable = (typeof TENANT_TABLES)[number];
