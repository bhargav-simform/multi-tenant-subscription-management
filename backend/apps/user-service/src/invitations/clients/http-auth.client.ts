import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalHttpClient } from '@app/tenant-context';
import type { IAuthClient } from './auth-client.interface';

/**
 * §9.4: uses InternalHttpClient, not raw HttpService — every call is signed.
 * Called from within acceptInvitation's transactionWithDeferredScope, before
 * setScope() runs (§11.5 — the invitee has no tenant context of their own
 * yet), matching how tenant-service's onboarding saga calls this same
 * endpoint with no ALS scope open either.
 */
@Injectable()
export class HttpAuthClient implements IAuthClient {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly config: ConfigService,
  ) {}

  async createCredentials(data: {
    organizationId: string;
    email: string;
    password: string;
  }): Promise<{ userId: string }> {
    const baseUrl = this.config.getOrThrow<string>('AUTH_SERVICE_URL');
    const response = await this.http.post<{ userId: string }>(
      `${baseUrl}/internal/auth/credentials`,
      data,
    );
    return response.data;
  }
}
