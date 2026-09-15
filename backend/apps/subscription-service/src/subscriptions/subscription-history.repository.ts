import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SubscriptionHistory } from './subscription-history.entity';
import type { ISubscriptionHistoryRepository } from './subscription-history.repository.interface';

@Injectable()
export class SubscriptionHistoryRepository implements ISubscriptionHistoryRepository {
  async record(
    data: { organizationId: string; fromPlanId: string | null; toPlanId: string; changedBy: string },
    manager: EntityManager,
  ): Promise<void> {
    const repo = manager.getRepository(SubscriptionHistory);
    await repo.save(repo.create(data));
  }
}
