import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalHttpClient } from '@app/tenant-context';
import type { ISubscriptionClient } from '../subscription-client.interface';

/** §9.4: InternalHttpClient signs this call (anonymous context — no ALS scope open yet). */
@Injectable()
export class HttpSubscriptionClient implements ISubscriptionClient {
  constructor(
    private readonly http: InternalHttpClient,
    private readonly config: ConfigService,
  ) {}

  async assignDefaultPlan(organizationId: string): Promise<{ subscriptionId: string }> {
    const baseUrl = this.config.getOrThrow<string>('SUBSCRIPTION_SERVICE_URL');
    const response = await this.http.post<{ subscriptionId: string }>(
      `${baseUrl}/internal/subscriptions`,
      { organizationId },
    );
    return response.data;
  }
}
