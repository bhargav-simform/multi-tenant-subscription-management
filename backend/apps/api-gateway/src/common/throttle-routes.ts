/**
 * §10.2: "Stricter buckets on /auth/login and /onboarding/signup (the public routes)."
 *
 * These are expressed as a route list matched from the ThrottlerModule config rather
 * than as @Throttle() decorators on the handlers, for two reasons:
 *
 *   1. It keeps the answer to "which routes can an anonymous caller hit, and how hard?"
 *      in ONE greppable list, next to the limits themselves — the same auditability
 *      argument §11.5 makes for keeping the @Public() routes countable.
 *   2. It keeps @nestjs/throttler out of the controllers' import graph, which matters
 *      concretely here: the package ships CommonJS that `require()`s @nestjs/common,
 *      and the repo's ESM Jest configuration cannot load that from a controller pulled
 *      into a unit test. Configuring the buckets in one module-level factory confines
 *      that constraint to bootstrap code no unit test imports.
 *
 * Path matching is against the full prefixed path (§10.2's global prefix), anchored
 * and exact — a prefix match would let /auth/login-something inherit the strict bucket
 * or, worse, a future /auth/login/anything escape it.
 */
export const STRICT_THROTTLE_PATHS: readonly string[] = [
  '/api/v1/auth/login',
  // A refresh is an unauthenticated write (see AuthController's note on why this route
  // is @Public()), so it belongs in the same bucket as login rather than the default one.
  '/api/v1/auth/refresh',
  '/api/v1/onboarding/signup',
];

/** Health probes are exempt from throttling entirely — a rate-limited readiness probe reports a false outage. */
export const UNTHROTTLED_PATHS: readonly string[] = ['/api/v1/health', '/api/v1/health/ready'];

export function normalisePath(url: string | undefined): string {
  return (url ?? '').split('?')[0].replace(/\/+$/, '') || '/';
}

export function isStrictThrottlePath(url: string | undefined): boolean {
  return STRICT_THROTTLE_PATHS.includes(normalisePath(url));
}

export function isUnthrottledPath(url: string | undefined): boolean {
  return UNTHROTTLED_PATHS.includes(normalisePath(url));
}
