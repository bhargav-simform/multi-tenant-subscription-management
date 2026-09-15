import { Controller, Get, Query } from '@nestjs/common';
import { UsageService } from './usage.service';
import { UsageAggregateQueryDto } from './dto/usage-aggregate-query.dto';
import type { UsageAggregateResponseDto } from './dto/usage-aggregate-response.dto';

/**
 * §8.5, R9: internal-only — called by tenant-service (or api-gateway) to
 * enrich the platform-admin org list with plan/usage. No @CheckAbility() —
 * the CALLER is another service (§9.4's InternalContextGuard verifies the
 * signature); the platform-admin role check happens one hop up, at whatever
 * service actually serves the platform admin's browser request.
 */
@Controller('internal/usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('aggregate')
  getAggregate(@Query() query: UsageAggregateQueryDto): Promise<UsageAggregateResponseDto[]> {
    return this.usage.getAggregates(query.organizationId);
  }
}
