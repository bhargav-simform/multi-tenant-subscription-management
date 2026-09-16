import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AxiosError, AxiosRequestConfig } from 'axios';
import { InternalHttpClient } from '@app/tenant-context';
import { DownstreamConfig, type DownstreamService } from './downstream.config';

export interface ProxyRequest {
  service: DownstreamService;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

/**
 * §10.2/§10.3: the gateway's whole job in one class — forward the request, let
 * the downstream service's own ValidationPipe validate input and its own CASL
 * guard authorise it. There is deliberately NO request/response shaping here
 * beyond error-shape normalisation (§10.3's last bullet): a gateway that
 * rewrites bodies eventually needs to know what a plan limit is, and that is
 * the exact drift this service must not have.
 *
 * The signed x-internal-context header is NOT constructed here. InternalHttpClient
 * (§9.4) reads whatever ALS tenant-context scope is currently open and signs it —
 * TenantContextInterceptor opens that scope from the verified JWT for authenticated
 * routes, and leaves it closed for the @Public() ones, where InternalHttpClient's
 * own no-scope branch signs an ANONYMOUS context. That is why no route here passes
 * an orgId of any kind: there is no code path through which it could.
 */
@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);

  constructor(
    private readonly http: InternalHttpClient,
    private readonly downstream: DownstreamConfig,
  ) {}

  async forward<T>(req: ProxyRequest): Promise<T> {
    const url = this.downstream.urlFor(req.service, req.path);
    const config: AxiosRequestConfig = req.query ? { params: req.query } : {};

    try {
      switch (req.method) {
        case 'GET':
          return (await this.http.get<T>(url, config)).data;
        case 'POST':
          return (await this.http.post<T>(url, req.body, config)).data;
        case 'PATCH':
          return (await this.http.patch<T>(url, req.body, config)).data;
        case 'DELETE':
          return (await this.http.delete<T>(url, config)).data;
      }
    } catch (err) {
      throw this.normalise(err as AxiosError, req);
    }
  }

  /**
   * §10.3: error-shape normalisation only. A downstream 404/409/403 is passed
   * through UNCHANGED — collapsing a downstream 404 into a 500 would destroy the
   * cross-tenant contract (§13, H1: a foreign-tenant id must surface to the client
   * as 404, not as a gateway error). Only a genuine transport failure — the
   * downstream service being unreachable, with no HTTP response at all — becomes
   * a 503, because that is what it actually is.
   */
  private normalise(err: AxiosError, req: ProxyRequest): HttpException {
    const response = err.response;
    if (!response) {
      this.logger.warn(
        `Downstream ${req.service} unreachable for ${req.method} ${req.path}: ${err.message}`,
      );
      return new ServiceUnavailableException(
        `The ${req.service} service is temporarily unavailable. Please retry.`,
      );
    }

    const status =
      typeof response.status === 'number' ? response.status : HttpStatus.BAD_GATEWAY;
    const body = response.data ?? { statusCode: status, message: 'Downstream error' };
    return new HttpException(body as string | Record<string, unknown>, status);
  }
}
