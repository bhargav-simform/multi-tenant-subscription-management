import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import type { ISubscriptionClient } from '../subscription-client.interface';

@Injectable()
export class HttpSubscriptionClient implements ISubscriptionClient {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async assignDefaultPlan(organizationId: string): Promise<{ subscriptionId: string }> {
    const baseUrl = this.config.getOrThrow<string>('SUBSCRIPTION_SERVICE_URL');
    const response = await firstValueFrom(
      this.http.post<{ subscriptionId: string }>(`${baseUrl}/internal/subscriptions`, {
        organizationId,
      }),
    );
    return response.data;
  }
}
