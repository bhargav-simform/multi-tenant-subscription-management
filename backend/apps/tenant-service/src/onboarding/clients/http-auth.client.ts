import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import type { IAuthClient } from '../auth-client.interface';

@Injectable()
export class HttpAuthClient implements IAuthClient {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async createCredentials(data: {
    organizationId: string;
    email: string;
    password: string;
  }): Promise<{ userId: string }> {
    const baseUrl = this.config.getOrThrow<string>('AUTH_SERVICE_URL');
    const response = await firstValueFrom(
      this.http.post<{ userId: string }>(`${baseUrl}/internal/auth/credentials`, data),
    );
    return response.data;
  }
}
