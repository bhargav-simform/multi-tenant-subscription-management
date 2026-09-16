import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * §9.2/§10.2: the six downstream services this gateway routes to. Base URLs come
 * from config (Docker-internal hostnames) — the gateway is the only service that
 * needs all six, because it is the only one doing path-prefix routing.
 */
export type DownstreamService =
  | 'auth'
  | 'tenant'
  | 'user'
  | 'subscription'
  | 'resource'
  | 'audit';

@Injectable()
export class DownstreamConfig {
  private readonly baseUrls: Record<DownstreamService, string>;

  constructor(config: ConfigService) {
    this.baseUrls = {
      auth: config.get<string>('AUTH_SERVICE_URL', 'http://auth-service:3002'),
      tenant: config.get<string>('TENANT_SERVICE_URL', 'http://tenant-service:3001'),
      user: config.get<string>('USER_SERVICE_URL', 'http://user-service:3003'),
      subscription: config.get<string>(
        'SUBSCRIPTION_SERVICE_URL',
        'http://subscription-service:3004',
      ),
      resource: config.get<string>('RESOURCE_SERVICE_URL', 'http://resource-service:3005'),
      audit: config.get<string>('AUDIT_SERVICE_URL', 'http://audit-service:3006'),
    };
  }

  urlFor(service: DownstreamService, path: string): string {
    const base = this.baseUrls[service].replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
  }
}
