import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { HttpException } from '../lib/http-errors';

/**
 * Which routes an anonymous caller can hit, and how hard — kept as one list rather
 * than scattered per route. Matching is against the full prefixed path, exact after
 * stripping the query string and trailing slashes, so /auth/login-something never
 * inherits (or escapes) the strict bucket.
 */
export const STRICT_THROTTLE_PATHS: readonly string[] = [
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/onboarding/signup',
];

/** A rate-limited readiness probe reports a false outage. */
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

interface Bucket {
  name: 'default' | 'strict';
  ttlMs: number;
  limit: number;
}

/**
 * Fixed-window counters, in process memory. Same semantics as the old
 * Redis-backed @nestjs/throttler storage (INCR, PEXPIRE on the first hit, PTTL),
 * which is why Reset and Retry-After are in milliseconds. Per-process: with more than
 * one backend replica the effective limit is N times the configured one.
 */
const counters = new Map<string, { hits: number; expiresAt: number }>();
const blocks = new Map<string, number>();

function increment(key: string, ttlMs: number, limit: number) {
  const now = Date.now();
  let counter = counters.get(key);
  if (!counter || counter.expiresAt <= now) {
    counter = { hits: 0, expiresAt: now + ttlMs };
    counters.set(key, counter);
  }
  counter.hits += 1;
  const timeToExpire = counter.expiresAt - now;
  const isBlocked = counter.hits > limit;

  let timeToBlockExpire = 0;
  if (isBlocked) {
    // blockDuration defaults to the window ttl; the block marker is set once (NX).
    const blockedUntil = blocks.get(key);
    if (blockedUntil === undefined || blockedUntil <= now) {
      blocks.set(key, now + ttlMs);
      timeToBlockExpire = ttlMs;
    } else {
      timeToBlockExpire = blockedUntil - now;
    }
  }
  return { totalHits: counter.hits, timeToExpire, isBlocked, timeToBlockExpire };
}

/** Drop expired windows so the maps do not grow without bound. */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, c] of counters) if (c.expiresAt <= now) counters.delete(key);
  for (const [key, until] of blocks) if (until <= now) blocks.delete(key);
}, 60_000);
sweeper.unref();

/** For tests. */
export function resetThrottleState(): void {
  counters.clear();
  blocks.clear();
}

function bucketFor(url: string): Bucket | null {
  if (isUnthrottledPath(url)) return null;
  if (isStrictThrottlePath(url)) {
    return { name: 'strict', ttlMs: env.throttleStrictTtlMs, limit: env.throttleStrictLimit };
  }
  return { name: 'default', ttlMs: env.throttleTtlMs, limit: env.throttleLimit };
}

/**
 * Put first on every route. Keyed per route handler + bucket + client IP (req.ip),
 * like the Nest throttler's key, so each route has its own budget per caller.
 * Headers and the 429 body are the ones the frontend has always seen.
 */
export function throttle(req: Request, res: Response, next: NextFunction): void {
  const bucket = bucketFor(req.originalUrl);
  if (!bucket) return next();

  const routePath = (req.route as { path?: string } | undefined)?.path ?? '';
  const handlerId = `${req.method} ${req.baseUrl}${routePath}`;
  const key = createHash('sha256')
    .update(`${handlerId}-${bucket.name}-${req.ip ?? ''}`)
    .digest('hex');
  const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } = increment(
    key,
    bucket.ttlMs,
    bucket.limit,
  );
  const suffix = bucket.name === 'default' ? '' : `-${bucket.name}`;

  if (isBlocked) {
    res.setHeader(`Retry-After${suffix}`, String(timeToBlockExpire));
    throw new HttpException('ThrottlerException: Too Many Requests', 429);
  }

  res.setHeader(`X-RateLimit-Limit${suffix}`, String(bucket.limit));
  res.setHeader(`X-RateLimit-Remaining${suffix}`, String(Math.max(0, bucket.limit - totalHits)));
  res.setHeader(`X-RateLimit-Reset${suffix}`, String(timeToExpire));
  next();
}
