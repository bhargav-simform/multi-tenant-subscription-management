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
    // getOrThrow, not a fallback: a hardcoded default here would silently mask
    // a missing *_SERVICE_URL in any environment where docker-compose's
    // container-name-based defaults don't apply (e.g. Kubernetes), routing
    // requests to a hostname that was never actually configured.
    this.baseUrls = {
      auth: config.getOrThrow<string>('AUTH_SERVICE_URL'),
      tenant: config.getOrThrow<string>('TENANT_SERVICE_URL'),
      user: config.getOrThrow<string>('USER_SERVICE_URL'),
      subscription: config.getOrThrow<string>('SUBSCRIPTION_SERVICE_URL'),
      resource: config.getOrThrow<string>('RESOURCE_SERVICE_URL'),
      audit: config.getOrThrow<string>('AUDIT_SERVICE_URL'),
    };
  }

  urlFor(service: DownstreamService, path: string): string {
    const base = this.baseUrls[service].replace(/\/+$/, '');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${base}${suffix}`;
  }
}
