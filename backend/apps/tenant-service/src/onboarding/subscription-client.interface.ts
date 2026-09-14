export const SUBSCRIPTION_CLIENT = Symbol('SUBSCRIPTION_CLIENT');

/**
 * §9.2: tenant-service -> subscription-service is synchronous REST (internal) —
 * the saga must confirm the default plan was assigned before completing (§11.3,
 * §30.1 step SUBSCRIBED).
 */
export interface ISubscriptionClient {
  assignDefaultPlan(organizationId: string): Promise<{ subscriptionId: string }>;
}
