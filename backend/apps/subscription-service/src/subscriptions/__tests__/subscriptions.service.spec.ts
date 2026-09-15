import { jest, describe, it, expect } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { EventPublisher } from '@app/kafka';
import { EVENT_TYPES, Role } from '@app/common';
import { SubscriptionsService } from '../subscriptions.service';
import { PLAN_REPOSITORY } from '../../plans/plan.repository.interface';
import { SUBSCRIPTION_REPOSITORY } from '../subscription.repository.interface';
import { SUBSCRIPTION_HISTORY_REPOSITORY } from '../subscription-history.repository.interface';
import { PlanCode, type Plan } from '../../plans/plan.entity';
import { SubscriptionStatus, type Subscription } from '../subscription.entity';

const ORG_ID = 'org-1';

/**
 * §19.10: the downgrade transaction. Not the R7 concurrency case (that's
 * user-service's seat lock, covered by the real Testcontainers suite), but
 * the SAME shape (lock, check against target, reject-or-write in one
 * transaction, CHECK-safe) applied to a plan change.
 */
describe('SubscriptionsService', () => {
  function makePlan(overrides: Partial<Plan> = {}): Plan {
    return {
      id: 'plan-free',
      code: PlanCode.FREE,
      name: 'Free',
      maxUsers: 5,
      maxStorageBytes: 5_000_000_000,
      isActive: true,
      ...overrides,
    };
  }

  function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
    return {
      id: 'sub-1',
      organizationId: ORG_ID,
      planId: 'plan-free',
      status: SubscriptionStatus.ACTIVE,
      usedSeats: 3,
      usedStorageBytes: 1_000_000,
      maxSeatsSnapshot: 5,
      maxStorageSnapshot: 5_000_000_000,
      currentPeriodEnd: null,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function buildContext() {
    return {
      userId: 'admin-1',
      organizationId: ORG_ID,
      roles: [Role.ORG_ADMIN],
      correlationId: 'corr-1',
      iat: 0,
      exp: 0,
    };
  }

  async function buildService(deps: { plans: Plan[]; subscription: Subscription | null }) {
    const tenantContext = new TenantContextStore();

    const dataSource = {
      transaction: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) => work({})),
      transactionForOrganization: jest
        .fn<(organizationId: string, work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (_organizationId, work) => work({})),
      runGlobal: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) => work({})),
    };

    const plans = {
      findAll: jest.fn<() => Promise<Plan[]>>().mockResolvedValue(deps.plans),
      findByCode: jest
        .fn<(code: string) => Promise<Plan | null>>()
        .mockImplementation(async (code) => deps.plans.find((p) => p.code === code) ?? null),
      findById: jest
        .fn<(id: string) => Promise<Plan | null>>()
        .mockImplementation(async (id) => deps.plans.find((p) => p.id === id) ?? null),
      findDefault: jest
        .fn<() => Promise<Plan>>()
        .mockResolvedValue(deps.plans.find((p) => p.code === PlanCode.FREE)!),
    };

    let currentSubscription = deps.subscription;
    const subscriptions = {
      findByOrganizationId: jest
        .fn<() => Promise<Subscription | null>>()
        .mockImplementation(async () => currentSubscription),
      create: jest
        .fn<(data: { id: string }) => Promise<Subscription>>()
        .mockImplementation(async (data) => {
          currentSubscription = makeSubscription({ id: data.id, usedSeats: 0 });
          return currentSubscription;
        }),
      lockByOrganizationId: jest
        .fn<() => Promise<Subscription | null>>()
        .mockImplementation(async () => currentSubscription),
      applyPlanChange: jest
        .fn<(organizationId: string, data: { planId: string; maxSeatsSnapshot: number; maxStorageSnapshot: number }, manager: unknown) => Promise<void>>()
        .mockImplementation(async (_orgId, data) => {
          currentSubscription = { ...currentSubscription!, ...data };
        }),
      updateUsedStorageBytes: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const history = {
      record: jest.fn<(data: unknown, manager: unknown) => Promise<void>>().mockResolvedValue(undefined),
    };

    const publisher = {
      publish: jest.fn<(topic: string, event: unknown) => Promise<void>>().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SubscriptionsService,
        { provide: TenantAwareDataSource, useValue: dataSource },
        { provide: TenantContextStore, useValue: tenantContext },
        { provide: EventPublisher, useValue: publisher },
        { provide: PLAN_REPOSITORY, useValue: plans },
        { provide: SUBSCRIPTION_REPOSITORY, useValue: subscriptions },
        { provide: SUBSCRIPTION_HISTORY_REPOSITORY, useValue: history },
      ],
    }).compile();

    return {
      service: moduleRef.get(SubscriptionsService),
      tenantContext,
      subscriptions,
      history,
      publisher,
    };
  }

  describe('assignDefaultPlan', () => {
    it('creates a subscription against the FREE plan and publishes SubscriptionAssigned', async () => {
      const freePlan = makePlan();
      const { service, publisher } = await buildService({ plans: [freePlan], subscription: null });

      const result = await service.assignDefaultPlan(ORG_ID);

      expect(result.subscriptionId).toBeDefined();
      expect(publisher.publish).toHaveBeenCalledWith(
        'subscription.events',
        expect.objectContaining({ eventType: EVENT_TYPES.SUBSCRIPTION_ASSIGNED }),
      );
    });
  });

  describe('changePlan (§19.10)', () => {
    it('blocks a seat-only overage with a message naming the SPECIFIC count to remove', async () => {
      const freePlan = makePlan({ maxUsers: 5, maxStorageBytes: 5_000_000_000 });
      const proPlan = makePlan({ id: 'plan-pro', code: PlanCode.PRO, maxUsers: 25, maxStorageBytes: 5_000_000_000 });
      // 10 seats held, downgrading to a 5-seat plan: 5 over, storage is fine.
      const subscription = makeSubscription({
        planId: proPlan.id,
        usedSeats: 10,
        maxSeatsSnapshot: 25,
        usedStorageBytes: 1_000_000,
      });
      const { service, tenantContext, subscriptions } = await buildService({
        plans: [freePlan, proPlan],
        subscription,
      });

      await expect(
        tenantContext.run(buildContext(), () => service.changePlan(PlanCode.FREE)),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          error: 'PLAN_LIMIT_EXCEEDED',
          details: expect.objectContaining({ limitType: 'seats', limit: 5, current: 10 }),
          // §19.10's required shape: the SPECIFIC amount (5, not just "10" and
          // "5" separately) and no mention of storage, which is not the problem.
          message: expect.stringContaining('Remove 5 users'),
        }),
      });

      // Nothing written — the check happens before any mutation.
      expect(subscriptions.applyPlanChange).not.toHaveBeenCalled();
    });

    it('blocks a storage-only overage without mentioning seats, and reports limitType: storage', async () => {
      const freePlan = makePlan({ maxUsers: 25, maxStorageBytes: 1_000_000_000 });
      const proPlan = makePlan({ id: 'plan-pro', code: PlanCode.PRO, maxUsers: 25, maxStorageBytes: 50_000_000_000 });
      // Seats fit the target plan; storage does not.
      const subscription = makeSubscription({
        planId: proPlan.id,
        usedSeats: 10,
        maxSeatsSnapshot: 25,
        usedStorageBytes: 5_000_000_000,
      });
      const { service, tenantContext, subscriptions } = await buildService({
        plans: [freePlan, proPlan],
        subscription,
      });

      await expect(
        tenantContext.run(buildContext(), () => service.changePlan(PlanCode.FREE)),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          error: 'PLAN_LIMIT_EXCEEDED',
          details: expect.objectContaining({ limitType: 'storage' }),
          message: expect.not.stringContaining('Remove'),
        }),
      });
      expect(subscriptions.applyPlanChange).not.toHaveBeenCalled();
    });

    it('allows a downgrade when usage fits the target plan, updating BOTH snapshot columns', async () => {
      const freePlan = makePlan({ maxUsers: 5, maxStorageBytes: 5_000_000_000 });
      const proPlan = makePlan({ id: 'plan-pro', code: PlanCode.PRO, maxUsers: 25 });
      const subscription = makeSubscription({
        planId: proPlan.id,
        usedSeats: 3,
        usedStorageBytes: 1_000_000,
        maxSeatsSnapshot: 25,
      });
      const { service, tenantContext, subscriptions, history, publisher } = await buildService({
        plans: [freePlan, proPlan],
        subscription,
      });

      await tenantContext.run(buildContext(), () => service.changePlan(PlanCode.FREE));

      expect(subscriptions.applyPlanChange).toHaveBeenCalledWith(
        ORG_ID,
        expect.objectContaining({
          planId: freePlan.id,
          maxSeatsSnapshot: freePlan.maxUsers,
          maxStorageSnapshot: freePlan.maxStorageBytes,
        }),
        expect.anything(),
      );
      expect(history.record).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: ORG_ID, fromPlanId: proPlan.id, toPlanId: freePlan.id }),
        expect.anything(),
      );
      expect(publisher.publish).toHaveBeenCalledWith(
        'subscription.events',
        expect.objectContaining({ eventType: EVENT_TYPES.SUBSCRIPTION_CHANGED }),
      );
    });

    it('throws NotFoundException for an unknown plan code', async () => {
      const freePlan = makePlan();
      const { service, tenantContext } = await buildService({
        plans: [freePlan],
        subscription: makeSubscription(),
      });

      await expect(
        tenantContext.run(buildContext(), () => service.changePlan('not-a-real-plan')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getCurrent', () => {
    it('throws NotFoundException when no subscription exists for the org', async () => {
      const { service, tenantContext } = await buildService({
        plans: [makePlan()],
        subscription: null,
      });

      await expect(
        tenantContext.run(buildContext(), () => service.getCurrent()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the current plan and usage', async () => {
      const freePlan = makePlan();
      const { service, tenantContext } = await buildService({
        plans: [freePlan],
        subscription: makeSubscription({ planId: freePlan.id }),
      });

      const result = await tenantContext.run(buildContext(), () => service.getCurrent());

      expect(result.planCode).toBe(PlanCode.FREE);
      expect(result.usedSeats).toBe(3);
      expect(result.maxSeats).toBe(5);
    });
  });
});
