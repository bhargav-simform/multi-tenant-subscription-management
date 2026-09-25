import { contextStore } from '../../src/lib/context-store';
import { NotFoundException } from '../../src/lib/http-errors';
import type { Plan } from '../../src/models/plan.model';
import type { Subscription } from '../../src/models/subscription.model';
import { Role } from '../../src/types/constants';
import { EVENT_TYPES, TOPICS } from '../../src/types/events';

jest.mock('../../src/lib/tenant-db', () => ({
  transaction: jest.fn(async (work: (tx: unknown) => unknown) => work({})),
  transactionForOrganization: jest.fn(async (_orgId: string, work: (tx: unknown) => unknown) =>
    work({}),
  ),
  runGlobal: jest.fn(async (work: (tx: unknown) => unknown) => work({})),
}));
jest.mock('../../src/lib/events', () => ({ publish: jest.fn(async () => undefined) }));
jest.mock('../../src/models/plan.model');
jest.mock('../../src/models/subscription.model');
jest.mock('../../src/models/subscription-history.model');
jest.mock('../../src/services/plans.service');

import * as events from '../../src/lib/events';
import * as planModel from '../../src/models/plan.model';
import * as history from '../../src/models/subscription-history.model';
import * as subscriptionModel from '../../src/models/subscription.model';
import * as plansService from '../../src/services/plans.service';
import * as service from '../../src/services/subscriptions.service';

const ORG_ID = 'org-1';

const mocked = {
  publish: jest.mocked(events.publish),
  planFindById: jest.mocked(planModel.findById),
  findByCode: jest.mocked(plansService.findByCode),
  findDefault: jest.mocked(plansService.findDefault),
  findByOrganizationId: jest.mocked(subscriptionModel.findByOrganizationId),
  create: jest.mocked(subscriptionModel.create),
  lockByOrganizationId: jest.mocked(subscriptionModel.lockByOrganizationId),
  applyPlanChange: jest.mocked(subscriptionModel.applyPlanChange),
  record: jest.mocked(history.record),
};

/**
 * The downgrade transaction: lock, check against the TARGET plan, reject-or-write in
 * one transaction. Not the concurrency proof (that needs a real row lock).
 */
describe('subscriptions.service', () => {
  function makePlan(overrides: Partial<Plan> = {}): Plan {
    return {
      id: 'plan-free',
      code: 'free',
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
      status: 'active',
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

  function setup(deps: { plans: Plan[]; subscription: Subscription | null }) {
    jest.clearAllMocks();
    let current = deps.subscription;
    mocked.findByCode.mockImplementation(
      async (code) => deps.plans.find((p) => p.code === code) ?? null,
    );
    mocked.planFindById.mockImplementation(
      async (_tx, id) => deps.plans.find((p) => p.id === id) ?? null,
    );
    mocked.findDefault.mockResolvedValue(deps.plans.find((p) => p.code === 'free')!);
    mocked.findByOrganizationId.mockImplementation(async () => current);
    mocked.lockByOrganizationId.mockImplementation(async () => current);
    mocked.create.mockImplementation(async (_tx, data) => {
      current = makeSubscription({ id: data.id, usedSeats: 0 });
      return current;
    });
    mocked.applyPlanChange.mockImplementation(async (_tx, _orgId, data) => {
      current = { ...current!, ...data };
    });
    mocked.record.mockResolvedValue(undefined);
  }

  describe('assignDefaultPlan', () => {
    it('creates a subscription against the FREE plan and publishes SubscriptionAssigned', async () => {
      setup({ plans: [makePlan()], subscription: null });

      const result = await service.assignDefaultPlan(ORG_ID);

      expect(result.subscriptionId).toBeDefined();
      expect(mocked.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: result.subscriptionId,
          organizationId: ORG_ID,
          planId: 'plan-free',
        }),
      );
      expect(mocked.publish).toHaveBeenCalledWith(
        TOPICS.SUBSCRIPTION,
        expect.objectContaining({
          eventType: EVENT_TYPES.SUBSCRIPTION_ASSIGNED,
          organizationId: ORG_ID,
          payload: expect.objectContaining({ maxStorageBytes: 5_000_000_000, maxSeats: 5 }),
        }),
      );
    });
  });

  describe('changePlan', () => {
    it('blocks a seat-only overage with a message naming the SPECIFIC count to remove', async () => {
      const freePlan = makePlan({ maxUsers: 5, maxStorageBytes: 5_000_000_000 });
      const proPlan = makePlan({
        id: 'plan-pro',
        code: 'pro',
        maxUsers: 25,
        maxStorageBytes: 5_000_000_000,
      });
      setup({
        plans: [freePlan, proPlan],
        subscription: makeSubscription({
          planId: proPlan.id,
          usedSeats: 10,
          maxSeatsSnapshot: 25,
          usedStorageBytes: 1_000_000,
        }),
      });

      const err = await contextStore
        .run(buildContext(), () => service.changePlan('free'))
        .catch((e: unknown) => e);

      expect(err).toMatchObject({ status: 409 });
      expect((err as { getBody(): unknown }).getBody()).toEqual({
        statusCode: 409,
        error: 'PLAN_LIMIT_EXCEEDED',
        details: { limitType: 'seats', limit: 5, current: 10, planCode: 'free' },
        message:
          'Your organisation holds 10 seats and 0.0 GB. The Free plan allows 5 seats and 4.7 GB. ' +
          'Remove 5 users or revoke pending invitations before downgrading.',
      });
      expect(mocked.applyPlanChange).not.toHaveBeenCalled();
      expect(mocked.publish).not.toHaveBeenCalled();
    });

    it('blocks a storage-only overage without mentioning seats, and reports limitType: storage', async () => {
      const freePlan = makePlan({ maxUsers: 25, maxStorageBytes: 1_000_000_000 });
      const proPlan = makePlan({
        id: 'plan-pro',
        code: 'pro',
        maxUsers: 25,
        maxStorageBytes: 50_000_000_000,
      });
      setup({
        plans: [freePlan, proPlan],
        subscription: makeSubscription({
          planId: proPlan.id,
          usedSeats: 10,
          maxSeatsSnapshot: 25,
          usedStorageBytes: 5_000_000_000,
        }),
      });

      const err = await contextStore
        .run(buildContext(), () => service.changePlan('free'))
        .catch((e: unknown) => e);

      expect((err as { getBody(): unknown }).getBody()).toEqual({
        statusCode: 409,
        error: 'PLAN_LIMIT_EXCEEDED',
        details: {
          limitType: 'storage',
          limit: 1_000_000_000,
          current: 5_000_000_000,
          planCode: 'free',
        },
        message:
          'Your organisation holds 10 seats and 4.7 GB. The Free plan allows 25 seats and 0.9 GB. ' +
          'free up 3.7 GB of storage before downgrading.',
      });
      expect(mocked.applyPlanChange).not.toHaveBeenCalled();
    });

    it('names both dimensions when both are exceeded, with singular "user"', async () => {
      const freePlan = makePlan({ maxUsers: 5, maxStorageBytes: 1_000_000_000 });
      setup({
        plans: [freePlan],
        subscription: makeSubscription({
          planId: 'plan-pro',
          usedSeats: 6,
          usedStorageBytes: 2_073_741_824,
        }),
      });

      const err = await contextStore
        .run(buildContext(), () => service.changePlan('free'))
        .catch((e: unknown) => e);

      expect((err as { getBody(): Record<string, unknown> }).getBody()).toMatchObject({
        details: { limitType: 'seats', limit: 5, current: 6 },
        message: expect.stringContaining(
          'Remove 1 user or revoke pending invitations, or free up 1.0 GB of storage before downgrading.',
        ),
      });
    });

    it('allows a downgrade when usage fits the target plan, updating BOTH snapshot columns', async () => {
      const freePlan = makePlan({ maxUsers: 5, maxStorageBytes: 5_000_000_000 });
      const proPlan = makePlan({ id: 'plan-pro', code: 'pro', maxUsers: 25 });
      setup({
        plans: [freePlan, proPlan],
        subscription: makeSubscription({
          planId: proPlan.id,
          usedSeats: 3,
          usedStorageBytes: 1_000_000,
          maxSeatsSnapshot: 25,
        }),
      });

      const result = await contextStore.run(buildContext(), () => service.changePlan('free'));

      expect(mocked.applyPlanChange).toHaveBeenCalledWith(expect.anything(), ORG_ID, {
        planId: freePlan.id,
        maxSeatsSnapshot: freePlan.maxUsers,
        maxStorageSnapshot: freePlan.maxStorageBytes,
      });
      expect(mocked.record).toHaveBeenCalledWith(expect.anything(), {
        organizationId: ORG_ID,
        fromPlanId: proPlan.id,
        toPlanId: freePlan.id,
        changedBy: 'admin-1',
      });
      expect(mocked.publish).toHaveBeenCalledWith(
        TOPICS.SUBSCRIPTION,
        expect.objectContaining({
          eventType: EVENT_TYPES.SUBSCRIPTION_CHANGED,
          actorUserId: 'admin-1',
          payload: {
            fromPlanId: proPlan.id,
            toPlanId: freePlan.id,
            toPlanCode: 'free',
            maxSeats: 5,
            maxStorageBytes: 5_000_000_000,
          },
        }),
      );
      expect(result).toMatchObject({ planCode: 'free', maxSeats: 5 });
    });

    it('throws NotFoundException for an unknown plan code', async () => {
      setup({ plans: [makePlan()], subscription: makeSubscription() });

      const err = await contextStore
        .run(buildContext(), () => service.changePlan('not-a-real-plan'))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getBody()).toEqual({
        message: 'Plan "not-a-real-plan" does not exist',
        error: 'Not Found',
        statusCode: 404,
      });
    });
  });

  describe('getCurrent', () => {
    it('throws NotFoundException when no subscription exists for the org', async () => {
      setup({ plans: [makePlan()], subscription: null });

      await expect(
        contextStore.run(buildContext(), () => service.getCurrent()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the current plan and usage', async () => {
      const freePlan = makePlan();
      setup({ plans: [freePlan], subscription: makeSubscription({ planId: freePlan.id }) });

      const result = await contextStore.run(buildContext(), () => service.getCurrent());

      expect(result).toEqual({
        planCode: 'free',
        planName: 'Free',
        status: 'active',
        usedSeats: 3,
        maxSeats: 5,
        usedStorageBytes: 1_000_000,
        maxStorageBytes: 5_000_000_000,
      });
    });
  });
});
