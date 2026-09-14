import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContextPayload } from '@app/common';

/**
 * Signs and verifies the x-internal-context header (§9.4, §10.5).
 *
 * INTERNAL_SIGNING_SECRET is distinct from JWT_SECRET (§10.5) — compromising one
 * must not forge the other. Only api-gateway signs; every service verifies.
 */
@Injectable()
export class InternalContextSigner {
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(private readonly config: ConfigService) {
    this.secret = this.config.getOrThrow<string>('INTERNAL_SIGNING_SECRET');
    this.ttlSeconds = Number(this.config.get('INTERNAL_CONTEXT_TTL_SECONDS', '30'));
  }

  /** Called only by api-gateway, after verifying the client's JWT. */
  sign(
    partial: Omit<TenantContextPayload, 'iat' | 'exp'>,
  ): { payloadB64: string; signature: string } {
    const now = Math.floor(Date.now() / 1000);
    const payload: TenantContextPayload = {
      ...partial,
      iat: now,
      exp: now + this.ttlSeconds,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = this.computeSignature(payloadB64);
    return { payloadB64, signature };
  }

  /**
   * §9.4 "Anonymous context": for the gateway's three @Public() routes, where
   * there is no authenticated identity to sign yet. The signature still proves
   * the request came through the gateway within the TTL — it just asserts no
   * identity. This keeps InternalContextGuard's verification uniform: every
   * downstream service checks the same signature, never a Public() bypass of
   * its own (see internal-context.guard.ts).
   */
  signAnonymous(correlationId: string): { payloadB64: string; signature: string } {
    return this.sign({ userId: null, organizationId: null, roles: [], correlationId });
  }

  /**
   * Verifies signature AND expiry. Returns the payload on success, null on any
   * failure (bad signature, expired, malformed). Callers must reject with 401 on
   * null — never fall back to trusting an unsigned context (§10.5).
   */
  verify(payloadB64: string, signature: string): TenantContextPayload | null {
    if (!payloadB64 || !signature) return null;

    const expected = this.computeSignature(payloadB64);
    if (!this.safeEqual(expected, signature)) return null;

    let payload: TenantContextPayload;
    try {
      payload = JSON.parse(
        Buffer.from(payloadB64, 'base64').toString('utf8'),
      ) as TenantContextPayload;
    } catch {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;

    return payload;
  }

  private computeSignature(payloadB64: string): string {
    return createHmac('sha256', this.secret).update(payloadB64).digest('hex');
  }

  /** Constant-time comparison — a timing side-channel on signature checks is a real bug. */
  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
