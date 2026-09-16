import { describe, it, expect } from '@jest/globals';
import {
  isStrictThrottlePath,
  isUnthrottledPath,
  normalisePath,
  STRICT_THROTTLE_PATHS,
} from '../throttle-routes';

/**
 * §10.2: which routes get the strict rate-limit bucket. Worth testing rather than
 * eyeballing, because the failure mode is silent in both directions — a strict route
 * that slips into the default bucket becomes a password-guessing surface, and an
 * authenticated route that lands in the strict one throttles legitimate users at a
 * tenth of the intended rate with no error anyone would attribute to this list.
 */
describe('throttle route classification', () => {
  it('covers exactly the unauthenticated write routes', () => {
    expect([...STRICT_THROTTLE_PATHS].sort()).toEqual([
      '/api/v1/auth/login',
      '/api/v1/auth/refresh',
      '/api/v1/onboarding/signup',
    ]);
  });

  it.each(STRICT_THROTTLE_PATHS)('%s is strict', (path) => {
    expect(isStrictThrottlePath(path)).toBe(true);
  });

  it('ignores the query string and a trailing slash', () => {
    expect(isStrictThrottlePath('/api/v1/auth/login?next=/x')).toBe(true);
    expect(isStrictThrottlePath('/api/v1/auth/login/')).toBe(true);
  });

  it('does not strict-throttle authenticated routes', () => {
    expect(isStrictThrottlePath('/api/v1/users')).toBe(false);
    expect(isStrictThrottlePath('/api/v1/auth/logout')).toBe(false);
    expect(isStrictThrottlePath('/api/v1/resources')).toBe(false);
  });

  it('matches exactly, so a neighbouring path cannot inherit or escape the bucket', () => {
    // A prefix match would put /api/v1/auth/login-as-someone-else in the strict
    // bucket (harmless) but also let /api/v1/auth/loginX-style routes drift out of it.
    expect(isStrictThrottlePath('/api/v1/auth/login/extra')).toBe(false);
    expect(isStrictThrottlePath('/api/v1/auth/loginx')).toBe(false);
  });

  it('exempts only the health probes from throttling', () => {
    expect(isUnthrottledPath('/api/v1/health')).toBe(true);
    expect(isUnthrottledPath('/api/v1/health/ready')).toBe(true);
    expect(isUnthrottledPath('/api/v1/users')).toBe(false);
  });

  it('normalises an undefined url rather than throwing', () => {
    expect(normalisePath(undefined)).toBe('/');
    expect(isStrictThrottlePath(undefined)).toBe(false);
  });
});
