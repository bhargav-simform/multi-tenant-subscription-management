import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ProxyService } from '../proxy/proxy.service';
import { PlatformAdminGuard } from '../common/platform-admin.guard';

/**
 * §8.1's endpoint table. Note what is absent (§13.3): no route is
 * `/organizations/:orgId/<anything>`. `/organizations/me` takes no id at all —
 * "my organisation" is decided entirely by the signed context minted from the
 * caller's token, and there is no parameter through which a caller could name a
 * different one.
 */
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly proxy: ProxyService) {}

  /** Any authenticated role. tenant-service's CASL scopes it to the caller's own org. */
  @Get('me')
  getMine(): Promise<unknown> {
    return this.proxy.forward({ service: 'tenant', method: 'GET', path: '/organizations/me' });
  }

  /**
   * §8.1/§13.6: Platform Admin only. The coarse gate (§10.2) rejects an org
   * admin/member here rather than spending a downstream hop; tenant-service's CASL
   * rejects them again on the same rule against the loaded subject. Two checks on
   * purpose — this one is defence in depth, not the enforcement.
   */
  @Get()
  @UseGuards(PlatformAdminGuard)
  list(@Query() query: Record<string, string>): Promise<unknown> {
    return this.proxy.forward({
      service: 'tenant',
      method: 'GET',
      path: '/organizations',
      query,
    });
  }

  @Get(':id')
  @UseGuards(PlatformAdminGuard)
  getById(@Param('id') id: string): Promise<unknown> {
    return this.proxy.forward({
      service: 'tenant',
      method: 'GET',
      path: `/organizations/${encodeURIComponent(id)}`,
    });
  }
}
