import type { Plan } from '../models/plan.model';
import type { Subscription } from '../models/subscription.model';

export interface SubscriptionResponse {
  planCode: string;
  planName: string;
  status: string;
  usedSeats: number;
  maxSeats: number;
  usedStorageBytes: number;
  maxStorageBytes: number;
}

export interface AssignDefaultPlanResponse {
  subscriptionId: string;
}

export function toSubscriptionResponse(
  subscription: Subscription,
  plan: Plan,
): SubscriptionResponse {
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
