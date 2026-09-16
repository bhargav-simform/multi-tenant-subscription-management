import { Controller, Get } from '@nestjs/common';
import { ProxyService } from '../proxy/proxy.service';

/**
 * §10.4: THE ONE aggregation case in the entire gateway, and it is allowed for a
 * specific, stated reason — it saves the SPA a request waterfall on the most-visited
 * screen. "Any further aggregation requires a documented reason — otherwise the
 * gateway slowly becomes the monolith the architecture avoids."
 *
 * Note what this does NOT do, which is what keeps it inside §10.3: it combines two
 * responses into one object without inspecting either. It does not compute a
 * remaining-seats figure, does not decide whether a limit is near, does not reshape a
 * field. Any of those would require knowing what a plan limit is, and would belong
 * downstream.
 *
 * The two calls run in parallel (Promise.all) — a waterfall inside the gateway would
 * defeat the only reason this route exists. Both calls pick up the SAME open ALS
 * tenant-context scope opened by TenantContextInterceptor, so both are signed with
 * the same identity and the same correlationId (§26.2): one trace id covers the fan-out.
 * A rejection in either propagates, so a failed dashboard is a failed dashboard rather
 * than a half-rendered one with a silently missing panel.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly proxy: ProxyService) {}

  @Get()
  async get(): Promise<{ subscription: unknown; recentUsers: unknown }> {
    const [subscription, recentUsers] = await Promise.all([
      this.proxy.forward<unknown>({
        service: 'subscription',
        method: 'GET',
        path: '/subscriptions/current',
      }),
      this.proxy.forward<unknown>({
        service: 'user',
        method: 'GET',
        path: '/users',
        query: { limit: 5 },
      }),
    ]);

    return { subscription, recentUsers };
  }
}
