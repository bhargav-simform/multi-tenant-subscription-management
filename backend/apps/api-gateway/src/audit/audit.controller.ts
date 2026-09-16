import { Controller, Get, Query } from '@nestjs/common';
import { ProxyService } from '../proxy/proxy.service';

/**
 * §8.1/§8.7: audit-service's two READ routes. There is no write route here because
 * there is none downstream — audit records arrive over Kafka and only over Kafka, so
 * that no service can be persuaded to skip writing an audit trail.
 *
 * /audit/security is platform-admin-only, but that check is NOT duplicated here with
 * a PlatformAdminGuard: unlike /internal/usage/aggregate, audit-service enforces it
 * itself inside AuditService.listSecurityEvents against the caller's signed context.
 * Adding a second gate would imply the downstream one is optional. Same reasoning for
 * GET /audit, where the org-admin/platform-admin projection difference is a decision
 * only audit-service can make (§12.5).
 */
@Controller('audit')
export class AuditController {
  constructor(private readonly proxy: ProxyService) {}

  @Get()
  list(@Query() query: Record<string, string>): Promise<unknown> {
    return this.proxy.forward({ service: 'audit', method: 'GET', path: '/audit', query });
  }

  @Get('security')
  listSecurity(@Query() query: Record<string, string>): Promise<unknown> {
    return this.proxy.forward({
      service: 'audit',
      method: 'GET',
      path: '/audit/security',
      query,
    });
  }
}
