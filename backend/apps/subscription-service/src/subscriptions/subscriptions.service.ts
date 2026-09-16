import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { EventPublisher, type DomainEvent } from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS, PlanLimitExceededException } from '@app/common';
import { PLAN_REPOSITORY, type IPlanRepository } from '../plans/plan.repository.interface';
import {
  SUBSCRIPTION_REPOSITORY,
  type ISubscriptionRepository,
} from './subscription.repository.interface';
import {
  SUBSCRIPTION_HISTORY_REPOSITORY,
  type ISubscriptionHistoryRepository,
} from './subscription-history.repository.interface';
import type { AssignDefaultPlanResponseDto } from './dto/assign-default-plan-response.dto';
import type { SubscriptionResponseDto } from './dto/subscription-response.dto';
import type { Plan } from '../plans/plan.entity';
import type { Subscription } from './subscription.entity';

/**
 * §8.5: owns plans/limits lifecycle and the subscription row §19 locks.
 * §19.10's downgrade is the one place this service enforces a limit —
 * everywhere else (seats) enforcement is user-service's job (§19.4's
 * exhaustive list); this service only ever adjusts max_seats_snapshot, never
 * used_seats.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly tenantDataSource: TenantAwareDataSource,
    private readonly tenantContext: TenantContextStore,
    private readonly publisher: EventPublisher,
    @Inject(PLAN_REPOSITORY) private readonly plans: IPlanRepository,
    @Inject(SUBSCRIPTION_REPOSITORY) private readonly subscriptions: ISubscriptionRepository,
    @Inject(SUBSCRIPTION_HISTORY_REPOSITORY)
    private readonly history: ISubscriptionHistoryRepository,
  ) {}

  /**
   * §8.5: internal-only, called by tenant-service's onboarding saga
   * (§30.1's SUBSCRIBED step). Creates the row user-service's seat-lock
   * transactions depend on existing (§32.3's tracked gap — this is what
   * closes it).
   */
  async assignDefaultPlan(organizationId: string): Promise<AssignDefaultPlanResponseDto> {
    const plan = await this.plans.findDefault();
    const subscriptionId = randomUUID();

    await this.tenantDataSource.transactionForOrganization(organizationId, async (manager) => {
      await this.subscriptions.create(
        {
          id: subscriptionId,
          organizationId,
          planId: plan.id,
          maxSeatsSnapshot: plan.maxUsers,
          maxStorageSnapshot: plan.maxStorageBytes,
        },
        manager,
      );
      await this.history.record(
        { organizationId, fromPlanId: null, toPlanId: plan.id, changedBy: organizationId },
        manager,
      );
    });

    // Carries the plan's limits for the same reason SubscriptionChanged does
    // (see changePlan below). This event is what first populates
    // resource-service's plan_limit_cache for a newly-onboarded organisation
    // (§8.6) — without the ceiling in the payload, that service could not
    // enforce a storage limit until some later plan change happened to
    // deliver it.
    await this.publishEvent(organizationId, EVENT_TYPES.SUBSCRIPTION_ASSIGNED, {
      subscriptionId,
      planCode: plan.code,
      planId: plan.id,
      maxSeats: plan.maxUsers,
      maxStorageBytes: plan.maxStorageBytes,
    });

    return { subscriptionId };
  }

  async getCurrent(): Promise<SubscriptionResponseDto> {
    const ctx = this.tenantContext.getOrThrow();
    const organizationId = ctx.organizationId!;

    // §13.5, §32.4: subs.subscriptions is FORCE ROW LEVEL SECURITY — this
    // read MUST run inside a scoped transaction, or it silently returns
    // nothing for every organisation (not just a foreign one). plans.findById
    // is passed the same manager for a single round trip; plans itself is a
    // GLOBAL table so the manager's scoping is irrelevant to it either way.
    const { subscription, plan } = await this.tenantDataSource.transaction(async (manager) => {
      const sub = await this.subscriptions.findByOrganizationId(organizationId, manager);
      if (!sub) throw new NotFoundException();

      const p = await this.plans.findById(sub.planId, manager);
      if (!p) throw new NotFoundException();

      return { subscription: sub, plan: p };
    });

    return toSubscriptionDto(subscription, plan);
  }

  /**
   * §19.10: the one limit check this service enforces. Same shape as every
   * other §19 transaction — lock the subscription row first, compare
   * against the TARGET plan, reject with a specific 409 before writing
   * anything, and update BOTH snapshot columns in the same transaction so
   * the CHECK constraints are never transiently violated (D-Q4).
   */
  async changePlan(planCode: string): Promise<SubscriptionResponseDto> {
    const ctx = this.tenantContext.getOrThrow();
    const organizationId = ctx.organizationId!;

    const targetPlan = await this.plans.findByCode(planCode);
    if (!targetPlan) {
      throw new NotFoundException(`Plan "${planCode}" does not exist`);
    }

    const result = await this.tenantDataSource.transaction(async (manager) => {
      // §19.7: subscription row locked FIRST — this IS the subscription
      // row every other seat-changing path also locks; a downgrade racing
      // an invite is exactly the case this ordering exists to serialise.
      const current = await this.subscriptions.lockByOrganizationId(organizationId, manager);
      if (!current) throw new NotFoundException();

      const seatsOverBy = current.usedSeats - targetPlan.maxUsers;
      const storageOverBy = current.usedStorageBytes - targetPlan.maxStorageBytes;
      const seatsExceeded = seatsOverBy > 0;
      const storageExceeded = storageOverBy > 0;

      if (seatsExceeded || storageExceeded) {
        // §19.10's required shape: name the SPECIFIC amount to remove, not
        // just the two numbers either side of the comparison — and only
        // mention the dimension(s) that actually breached, never both
        // unconditionally (an admin told to "free up storage" when storage
        // was fine would be chasing the wrong fix).
        const seatsClause = seatsExceeded
          ? `Remove ${seatsOverBy} user${seatsOverBy === 1 ? '' : 's'} or revoke pending invitations`
          : null;
        const storageClause = storageExceeded
          ? `free up ${formatBytes(storageOverBy)} of storage`
          : null;
        const actions = [seatsClause, storageClause].filter(Boolean).join(', or ');

        throw new PlanLimitExceededException(
          {
            limitType: seatsExceeded ? 'seats' : 'storage',
            limit: seatsExceeded ? targetPlan.maxUsers : targetPlan.maxStorageBytes,
            current: seatsExceeded ? current.usedSeats : current.usedStorageBytes,
            planCode: targetPlan.code,
          },
          `Your organisation holds ${current.usedSeats} seats and ${formatBytes(current.usedStorageBytes)}. ` +
            `The ${targetPlan.name} plan allows ${targetPlan.maxUsers} seats and ` +
            `${formatBytes(targetPlan.maxStorageBytes)}. ${actions} before downgrading.`,
        );
      }

      await this.subscriptions.applyPlanChange(
        organizationId,
        {
          planId: targetPlan.id,
          maxSeatsSnapshot: targetPlan.maxUsers,
          maxStorageSnapshot: targetPlan.maxStorageBytes,
        },
        manager,
      );
      await this.history.record(
        {
          organizationId,
          fromPlanId: current.planId,
          toPlanId: targetPlan.id,
          changedBy: ctx.userId!,
        },
        manager,
      );

      return { fromPlanId: current.planId };
    });

    // §8.6: `maxStorageBytes`/`maxSeats` are carried in the payload rather
    // than left for a consumer to resolve from `toPlanId`. resource-service's
    // plan_limit_cache needs the new storage ceiling, and the alternative —
    // a consumer calling GET /plans over HTTP to translate the id — would put
    // a synchronous network dependency inside an event handler for a value
    // THIS service already holds at publish time. An event should carry what
    // its consumers need to act (§17.3).
    await this.publishEvent(organizationId, EVENT_TYPES.SUBSCRIPTION_CHANGED, {
      fromPlanId: result.fromPlanId,
      toPlanId: targetPlan.id,
      toPlanCode: targetPlan.code,
      maxSeats: targetPlan.maxUsers,
      maxStorageBytes: targetPlan.maxStorageBytes,
    });

    return this.getCurrent();
  }

  private async publishEvent<T>(
    organizationId: string,
    eventType: (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES],
    payload: T,
  ): Promise<void> {
    const event: DomainEvent<T> = {
      eventType,
      organizationId,
      actorUserId: this.tenantContext.get()?.userId ?? null,
      payload,
    };
    await this.publisher.publish(KAFKA_TOPICS.SUBSCRIPTION, event);
  }
}

function toSubscriptionDto(subscription: Subscription, plan: Plan): SubscriptionResponseDto {
  return {
    planCode: plan.code,
    planName: plan.name,
    status: subscription.status,
    usedSeats: subscription.usedSeats,
    maxSeats: subscription.maxSeatsSnapshot,
    usedStorageBytes: subscription.usedStorageBytes,
    maxStorageBytes: subscription.maxStorageSnapshot,
  };
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  return `${gb.toFixed(1)} GB`;
}
