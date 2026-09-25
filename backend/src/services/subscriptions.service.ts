import { randomUUID } from 'node:crypto';
import { contextStore } from '../lib/context-store';
import { publish } from '../lib/events';
import { NotFoundException, PlanLimitExceededException } from '../lib/http-errors';
import { transaction, transactionForOrganization } from '../lib/tenant-db';
import * as plans from '../models/plan.model';
import * as history from '../models/subscription-history.model';
import * as subscriptions from '../models/subscription.model';
import { EVENT_TYPES, TOPICS, type EventType } from '../types/events';
import {
  toSubscriptionResponse,
  type AssignDefaultPlanResponse,
  type SubscriptionResponse,
} from '../views/subscription.view';
import * as plansService from './plans.service';

/**
 * Called in-process by the onboarding saga. Creates the row the seat lock depends on
 * existing, then publishes SubscriptionAssigned with the plan's limits — that event
 * is what first populates plan_limit_cache for the new organisation.
 */
export async function assignDefaultPlan(
  organizationId: string,
): Promise<AssignDefaultPlanResponse> {
  const plan = await plansService.findDefault();
  const subscriptionId = randomUUID();

  await transactionForOrganization(organizationId, async (tx) => {
    await subscriptions.create(tx, {
      id: subscriptionId,
      organizationId,
      planId: plan.id,
      maxSeatsSnapshot: plan.maxUsers,
      maxStorageSnapshot: plan.maxStorageBytes,
    });
    // changedBy is the organisation id here (there is no acting user yet) — kept as before.
    await history.record(tx, {
      organizationId,
      fromPlanId: null,
      toPlanId: plan.id,
      changedBy: organizationId,
    });
  });

  await publishEvent(organizationId, EVENT_TYPES.SUBSCRIPTION_ASSIGNED, {
    subscriptionId,
    planCode: plan.code,
    planId: plan.id,
    maxSeats: plan.maxUsers,
    maxStorageBytes: plan.maxStorageBytes,
  });

  return { subscriptionId };
}

/** The caller's own subscription. 404 (bare) when there is no row or no plan. */
export async function getCurrent(): Promise<SubscriptionResponse> {
  const ctx = contextStore.getOrThrow();
  const organizationId = ctx.organizationId;

  return transaction(async (tx) => {
    // A platform admin has no org. The old TypeORM lookup rejected a null in its
    // WHERE clause, so this has always been a 500 for them, never a 404.
    if (organizationId === null) {
      throw new Error('getCurrent() called without an organizationId (platform-admin context)');
    }
    const subscription = await subscriptions.findByOrganizationId(tx, organizationId);
    if (!subscription) throw new NotFoundException();

    const plan = await plans.findById(tx, subscription.planId);
    if (!plan) throw new NotFoundException();

    return toSubscriptionResponse(subscription, plan);
  });
}

/**
 * The one limit this module enforces: lock the subscription row first, compare usage
 * against the TARGET plan, reject with a specific 409 before writing anything, and
 * update both snapshots together so the CHECK constraints never see a transient
 * violation. The 409 names only the dimension(s) that actually breached.
 */
export async function changePlan(planCode: string): Promise<SubscriptionResponse> {
  const ctx = contextStore.getOrThrow();
  const organizationId = ctx.organizationId as string;

  const targetPlan = await plansService.findByCode(planCode);
  if (!targetPlan) {
    throw new NotFoundException(`Plan "${planCode}" does not exist`);
  }

  const result = await transaction(async (tx) => {
    const current = organizationId
      ? await subscriptions.lockByOrganizationId(tx, organizationId)
      : null;
    if (!current) throw new NotFoundException();

    const seatsOverBy = current.usedSeats - targetPlan.maxUsers;
    const storageOverBy = current.usedStorageBytes - targetPlan.maxStorageBytes;
    const seatsExceeded = seatsOverBy > 0;
    const storageExceeded = storageOverBy > 0;

    if (seatsExceeded || storageExceeded) {
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

    await subscriptions.applyPlanChange(tx, organizationId, {
      planId: targetPlan.id,
      maxSeatsSnapshot: targetPlan.maxUsers,
      maxStorageSnapshot: targetPlan.maxStorageBytes,
    });
    await history.record(tx, {
      organizationId,
      fromPlanId: current.planId,
      toPlanId: targetPlan.id,
      changedBy: ctx.userId as string,
    });

    return { fromPlanId: current.planId };
  });

  // Carries the new limits so plan-limit-sync can refresh the storage ceiling
  // without resolving the plan itself.
  await publishEvent(organizationId, EVENT_TYPES.SUBSCRIPTION_CHANGED, {
    fromPlanId: result.fromPlanId,
    toPlanId: targetPlan.id,
    toPlanCode: targetPlan.code,
    maxSeats: targetPlan.maxUsers,
    maxStorageBytes: targetPlan.maxStorageBytes,
  });

  return getCurrent();
}

async function publishEvent<T>(
  organizationId: string,
  eventType: EventType,
  payload: T,
): Promise<void> {
  await publish(TOPICS.SUBSCRIPTION, {
    eventType,
    organizationId,
    actorUserId: contextStore.get()?.userId ?? null,
    payload,
  });
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  return `${gb.toFixed(1)} GB`;
}
