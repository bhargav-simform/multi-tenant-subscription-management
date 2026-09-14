/**
 * Interface the JwtStrategy depends on (§20.2 — depend on an abstraction, not a
 * concrete Redis client). api-gateway binds a Redis-backed implementation; unit
 * tests bind an in-memory one with no Redis at all.
 */
export interface TokenDenylist {
  isDenied(jti: string): Promise<boolean>;
  deny(jti: string, ttlSeconds: number): Promise<void>;
}

export const TOKEN_DENYLIST = Symbol('TOKEN_DENYLIST');
