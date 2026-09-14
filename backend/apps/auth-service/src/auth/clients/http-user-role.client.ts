import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import type { IUserRoleClient } from '../user-role-client.interface';

@Injectable()
export class HttpUserRoleClient implements IUserRoleClient {
  private readonly logger = new Logger(HttpUserRoleClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async getRole(userId: string): Promise<string | null> {
    const baseUrl = this.config.getOrThrow<string>('USER_SERVICE_URL');
    try {
      const response = await firstValueFrom(
        this.http.get<{ role: string }>(`${baseUrl}/internal/users/${userId}/role`),
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
