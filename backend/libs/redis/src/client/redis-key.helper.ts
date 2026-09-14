/**
 * §16.3: any tenant-scoped Redis key MUST include organizationId — a key
 * collision across tenants in a shared cache is a data leak. Use this helper
 * everywhere a cache key touches tenant data; never hand-build the string.
 */
export function tenantKey(organizationId: string, ...parts: string[]): string {
  return ['org', organizationId, ...parts].join(':');
}

export function platformKey(...parts: string[]): string {
  return ['platform', ...parts].join(':');
}
