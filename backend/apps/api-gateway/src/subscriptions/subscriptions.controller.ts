import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ProxyService } from '../proxy/proxy.service';
import { PlatformAdminGuard } from '../common/platform-admin.guard';

/** §8.1/§8.5: subscription-service's client-facing routes. */
@Controller()
export class SubscriptionsController {
  constructor(private readonly proxy: ProxyService) {}

  /** The plan catalogue is global, not tenant data — any authenticated caller. */
  @Get('plans')
  listPlans(): Promise<unknown> {
    return this.proxy.forward({ service: 'subscription', method: 'GET', path: '/plans' });
  }

  /** No id in the path (§13.3) — "current" means the caller's own, from the token. */
  @Get('subscriptions/current')
  current(): Promise<unknown> {
    return this.proxy.forward({
      service: 'subscription',
      method: 'GET',
      path: '/subscriptions/current',
    });
  }

  /** §19.10: a downgrade is a limit path. Its 409 passes straight through (R6). */
  @Post('subscriptions/change')
  change(@Body() body: unknown): Promise<unknown> {
    return this.proxy.forward({
      service: 'subscription',
      method: 'POST',
      path: '/subscriptions/change',
      body,
    });
  }

  /**
   * R9/§8.5: platform-admin aggregate usage — counts only, never content.
   *
   * PLATFORM ADMIN ONLY at the gateway, and this gate is load-bearing rather than
   * merely defence in depth. subscription-service's UsageController carries no
   * @CheckAbility by design: it is an `/internal/` route whose own doc comment says
   * "the platform-admin role check happens one hop up, at whatever service actually
   * serves the platform admin's browser request". This IS that hop. Without this
   * guard, any authenticated org member could read every organisation's usage by
   * naming an organizationId in the query string.
   */
  @Get('usage')
  @UseGuards(PlatformAdminGuard)
  usage(@Query() query: Record<string, string>): Promise<unknown> {
    return this.proxy.forward({
      service: 'subscription',
      method: 'GET',
      path: '/internal/usage/aggregate',
      query,
    });
  }
}
