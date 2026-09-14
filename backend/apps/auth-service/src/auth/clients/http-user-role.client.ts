import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { InternalHttpClient } from '@app/tenant-context';
import type { IUserRoleClient } from '../user-role-client.interface';

/**
 * §9.4: InternalHttpClient signs this call. No ALS scope is open at this
 * point (AuthService.login/refresh have not yet established one — they ARE
 * the thing establishing identity), so this is signed as an ANONYMOUS
 * context. user-service's InternalContextGuard verifies it identically to
 * any other request; its handler for /internal/users/:id/role does not need
 * caller identity, only the :id path parameter.
 */
@Injectable()
export class HttpUserRoleClient implements IUserRoleClient {
  private readonly logger = new Logger(HttpUserRoleClient.name);

  constructor(
    private readonly http: InternalHttpClient,
    private readonly config: ConfigService,
  ) {}

  async getRole(userId: string): Promise<string | null> {
    const baseUrl = this.config.getOrThrow<string>('USER_SERVICE_URL');
    try {
      const response = await this.http.get<{ role: string }>(
        `${baseUrl}/internal/users/${userId}/role`,
      );
      return response.data.role;
    } catch (err) {
      if (err instanceof AxiosError && err.response?.status === 404) {
        return null;
      }
      this.logger.error(`Failed to fetch role for user ${userId}: ${(err as Error).message}`);
      throw err;
    }
  }
}
