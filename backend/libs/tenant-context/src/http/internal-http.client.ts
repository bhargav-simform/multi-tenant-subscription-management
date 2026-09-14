import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { INTERNAL_CONTEXT_HEADER, INTERNAL_SIGNATURE_HEADER, CORRELATION_ID_HEADER } from '@app/common';
import { TenantContextStore } from '../store/tenant-context.store';
import { InternalContextSigner } from '../store/internal-context.signer';

/**
 * §9.4: the ONE place every service-to-service HTTP call gets its signed
 * x-internal-context header. Every internal client (HttpAuthClient,
 * HttpSubscriptionClient, HttpUserRoleClient, and every future one) MUST use
 * this wrapper instead of raw HttpService — a client that calls HttpService
 * directly sends an unsigned request, which the receiving service's
 * InternalContextGuard rejects with 401 (or, worse, would succeed if that
 * guard were ever weakened — this wrapper is what keeps every call correctly
 * authenticated by construction, not by each call site remembering to sign).
 *
 * Two cases:
 *   - An ALS scope is already open (this service is itself handling a
 *     request) → PROPAGATE that context forward. This is what makes a call
 *     chain like tenant-service → auth-service → (future) audit correlate
 *     under one correlationId and carry the same identity.
 *   - No ALS scope is open (a background job, or a call made before any
 *     tenant context exists — e.g. tenant-service's onboarding saga calling
 *     auth-service to CREATE the very identity that doesn't exist yet) →
 *     sign an ANONYMOUS context (§9.4), same mechanism the gateway uses for
 *     its three @Public() routes. The receiving guard verifies it identically
 *     either way; the receiving handler simply has no identity to read.
 */
@Injectable()
export class InternalHttpClient {
  constructor(
    private readonly http: HttpService,
    private readonly tenantContext: TenantContextStore,
    private readonly signer: InternalContextSigner,
  ) {}

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return firstValueFrom(this.http.get<T>(url, this.withSignedHeaders(config)));
  }

  async post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return firstValueFrom(this.http.post<T>(url, data, this.withSignedHeaders(config)));
  }

  async patch<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return firstValueFrom(this.http.patch<T>(url, data, this.withSignedHeaders(config)));
  }

  async delete<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return firstValueFrom(this.http.delete<T>(url, this.withSignedHeaders(config)));
  }

  private withSignedHeaders(config?: AxiosRequestConfig): AxiosRequestConfig {
    const ctx = this.tenantContext.get();
    const correlationId = ctx?.correlationId ?? randomUUID();

    const { payloadB64, signature } = ctx
      ? this.signer.sign({
          userId: ctx.userId,
          organizationId: ctx.organizationId,
          roles: ctx.roles,
          correlationId,
        })
      : this.signer.signAnonymous(correlationId);

    return {
      ...config,
      headers: {
        ...config?.headers,
        [INTERNAL_CONTEXT_HEADER]: payloadB64,
        [INTERNAL_SIGNATURE_HEADER]: signature,
        [CORRELATION_ID_HEADER]: correlationId,
      },
    };
  }
}
