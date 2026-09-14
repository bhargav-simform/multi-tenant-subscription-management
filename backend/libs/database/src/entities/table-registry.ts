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
 * Tables that carry `organization_id` (or an equivalent tenant reference) but are
 * DELIBERATELY NOT RLS-protected, because they have no cross-tenant LISTING
 * surface — every query against them is a lookup by a unique key the caller
 * already has (an id, an email, a token hash), never "give me all rows for
 * organisation X" filtered only by RLS. Two distinct justifications currently
 * live here, both documented at the point each table is created:
 *
 *   - `organizations`, `onboarding_sagas` (§8.3, tenant-service): the tenant
 *     REGISTRY itself, not tenant content. RLS would block platform admins'
 *     legitimate org-list read — this is what makes "platform admin sees orgs
 *     but not content" structural (§13.6).
 *   - `credentials`, `refresh_tokens` (§8.2, auth-service): always looked up by
 *     email or userId, never listed per organisation. auth_db has no RLS at
 *     all (§14.1) — a single-service database with no cross-tenant query
 *     surface for RLS to guard.
 *
 * A table belongs here ONLY under one of these justifications — never for
 * "it's inconvenient to scope". Adding a table here without a documented
 * reason is exactly the mistake §13.7 row 7 exists to catch.
 */
export const REGISTRY_TABLES = [
  'organizations',
  'onboarding_sagas',
  'credentials',
  'refresh_tokens',
] as const;

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
