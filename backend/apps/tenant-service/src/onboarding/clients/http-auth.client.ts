import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalHttpClient } from '@app/tenant-context';
import type { IAuthClient } from '../auth-client.interface';

/**
 * §9.4: uses InternalHttpClient, not raw HttpService — every call is signed.
 * This call runs with no ALS tenant context open (the saga is not itself
 * scoped to an organisation until AFTER this step), so InternalHttpClient
 * signs an ANONYMOUS context here. auth-service's InternalContextGuard
 * verifies it identically to any other request.
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
