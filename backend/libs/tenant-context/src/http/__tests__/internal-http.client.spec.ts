import { jest, describe, it, expect } from '@jest/globals';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';
import type { AxiosResponse } from 'axios';
import { INTERNAL_CONTEXT_HEADER, INTERNAL_SIGNATURE_HEADER, CORRELATION_ID_HEADER } from '@app/common';
import { InternalHttpClient } from '../internal-http.client';
import { TenantContextStore } from '../../store/tenant-context.store';
import { InternalContextSigner } from '../../store/internal-context.signer';

/**
 * §9.4: every service-to-service call must be signed. These tests are the
 * regression guard for the defect caught during user-service's
 * implementation (§32.4) — a call bypassing this wrapper sends no signature
 * at all, and every other service's InternalContextGuard rejects it.
 *
 * Built by hand (not via Test.createTestingModule) — InternalContextSigner's
 * constructor reads config eagerly, and a hand-built fake ConfigService is
 * simpler and more transparent here than a Nest DI override chain.
 */
describe('InternalHttpClient', () => {
  function fakeResponse<T>(data: T): AxiosResponse<T> {
    return {
      data,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as AxiosResponse['config'],
    };
  }

  function build() {
    const httpService = { get: jest.fn(), post: jest.fn() } as unknown as HttpService;
    const fakeConfig = {
      getOrThrow: () => 'test-secret',
      get: () => '30',
    };
    const signer = new InternalContextSigner(fakeConfig as never);
    const tenantContext = new TenantContextStore();
    const client = new InternalHttpClient(httpService, tenantContext, signer);
    return { client, httpService, tenantContext, signer };
  }

  it('EVERY outgoing call carries a signature the receiving guard can verify', async () => {
    const { client, httpService, signer } = build();
    (httpService.get as jest.Mock).mockReturnValue(of(fakeResponse({ ok: true })));

    await client.get('http://user-service/internal/x');

    const [, config] = (httpService.get as jest.Mock).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    const payloadB64 = config.headers[INTERNAL_CONTEXT_HEADER];
    const signature = config.headers[INTERNAL_SIGNATURE_HEADER];

    expect(payloadB64).toBeDefined();
    expect(signature).toBeDefined();
    // The receiving service's InternalContextGuard calls exactly this — if
    // it returns null, every service rejects the call with 401.
    expect(signer.verify(payloadB64, signature)).not.toBeNull();
  });

  it('signs an ANONYMOUS context (no identity) when no tenant scope is open', async () => {
    const { client, httpService, signer } = build();
    (httpService.post as jest.Mock).mockReturnValue(of(fakeResponse({ ok: true })));

    await client.post('http://auth-service/internal/auth/credentials', { email: 'a@b.test' });

    const [, , config] = (httpService.post as jest.Mock).mock.calls[0] as [
      string,
      unknown,
      { headers: Record<string, string> },
    ];
    const verified = signer.verify(
      config.headers[INTERNAL_CONTEXT_HEADER],
      config.headers[INTERNAL_SIGNATURE_HEADER],
    );

    expect(verified?.userId).toBeNull();
    expect(verified?.organizationId).toBeNull();
    expect(verified?.roles).toEqual([]);
  });

  it('PROPAGATES the current tenant context when a scope is already open', async () => {
    const { client, httpService, tenantContext, signer } = build();
    (httpService.get as jest.Mock).mockReturnValue(of(fakeResponse({ ok: true })));

    await tenantContext.run(
      {
        userId: 'user-1',
        organizationId: 'org-1',
        roles: [],
        correlationId: 'corr-1',
        iat: 0,
        exp: 0,
      },
      async () => {
        await client.get('http://resource-service/internal/x');
      },
    );

    const [, config] = (httpService.get as jest.Mock).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    const verified = signer.verify(
      config.headers[INTERNAL_CONTEXT_HEADER],
      config.headers[INTERNAL_SIGNATURE_HEADER],
    );

    expect(verified?.userId).toBe('user-1');
    expect(verified?.organizationId).toBe('org-1');
    expect(config.headers[CORRELATION_ID_HEADER]).toBe('corr-1');
  });
});
