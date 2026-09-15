import type { EntityManager } from 'typeorm';

export const SUBSCRIPTION_HISTORY_REPOSITORY = Symbol('SUBSCRIPTION_HISTORY_REPOSITORY');

export interface ISubscriptionHistoryRepository {
  record(
    data: { organizationId: string; fromPlanId: string | null; toPlanId: string; changedBy: string },
    manager: EntityManager,
  ): Promise<void>;
}
