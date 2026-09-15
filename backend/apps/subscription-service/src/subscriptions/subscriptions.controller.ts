import { Body, Controller, Get, Post } from '@nestjs/common';
import { Action, Subject } from '@app/common';
import { CheckAbility } from '@app/authorization';
import { SubscriptionsService } from './subscriptions.service';
import { AssignDefaultPlanDto } from './dto/assign-default-plan.dto';
import { AssignDefaultPlanResponseDto } from './dto/assign-default-plan-response.dto';
import { SubscriptionResponseDto } from './dto/subscription-response.dto';
import { ChangePlanDto } from './dto/change-plan.dto';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('current')
  @CheckAbility(Action.READ, Subject.SUBSCRIPTION)
  getCurrent(): Promise<SubscriptionResponseDto> {
    return this.subscriptions.getCurrent();
  }

  /** §19.10: a downgrade is a limit path — 409 if usage exceeds the target plan (D-Q4). */
  @Post('change')
  @CheckAbility(Action.UPDATE, Subject.SUBSCRIPTION)
  changePlan(@Body() dto: ChangePlanDto): Promise<SubscriptionResponseDto> {
    return this.subscriptions.changePlan(dto.planCode);
  }
}

/**
 * §8.5: internal-only, called by tenant-service's onboarding saga. No
 * @CheckAbility() — the caller is another service, authenticated by
 * InternalContextGuard's signature verification (§9.4), not a CASL role.
 */
@Controller('internal/subscriptions')
export class InternalSubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post()
  assignDefaultPlan(
    @Body() dto: AssignDefaultPlanDto,
  ): Promise<AssignDefaultPlanResponseDto> {
    return this.subscriptions.assignDefaultPlan(dto.organizationId);
  }
}
