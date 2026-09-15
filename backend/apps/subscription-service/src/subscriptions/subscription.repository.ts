import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Subscription } from './subscription.entity';
import type {
  CreateSubscriptionData,
  ISubscriptionRepository,
} from './subscription.repository.interface';

/**
 * §13.5, §32.4: `subs.subscriptions` has FORCE ROW LEVEL SECURITY — every
 * method here MUST run against a manager from a scoped transaction
 * (TenantAwareDataSource), never the raw injected DataSource. There is
 * deliberately no unscoped fallback path (unlike an earlier version of this
 * class, and unlike UserRepository's now-fixed equivalent) — every caller is
 * required to pass a manager, so a missing scope fails at the type level.
 */
@Injectable()
export class SubscriptionRepository implements ISubscriptionRepository {
  async findByOrganizationId(
    organizationId: string,
    manager: EntityManager,
  ): Promise<Subscription | null> {
    return manager.getRepository(Subscription).findOne({ where: { organizationId } });
  }

  async create(data: CreateSubscriptionData, manager: EntityManager): Promise<Subscription> {
    const repo = manager.getRepository(Subscription);
    const now = new Date();
    const subscription = repo.create({
      id: data.id,
      organizationId: data.organizationId,
      planId: data.planId,
      maxSeatsSnapshot: data.maxSeatsSnapshot,
      maxStorageSnapshot: data.maxStorageSnapshot,
      usedSeats: 0,
      usedStorageBytes: 0,
      createdAt: now,
      updatedAt: now,
    });
    return repo.save(subscription);
  }

  async lockByOrganizationId(
    organizationId: string,
    manager: EntityManager,
  ): Promise<Subscription | null> {
    return manager
      .getRepository(Subscription)
      .createQueryBuilder('sub')
      .setLock('pessimistic_write')
      .where('sub.organizationId = :organizationId', { organizationId })
      .getOne();
  }

  async applyPlanChange(
    organizationId: string,
    data: { planId: string; maxSeatsSnapshot: number; maxStorageSnapshot: number },
    manager: EntityManager,
  ): Promise<void> {
    await manager.getRepository(Subscription).update(
      { organizationId },
      {
        planId: data.planId,
        maxSeatsSnapshot: data.maxSeatsSnapshot,
        maxStorageSnapshot: data.maxStorageSnapshot,
        updatedAt: new Date(),
      },
    );
  }

  async updateUsedStorageBytes(
    organizationId: string,
    value: number,
    manager: EntityManager,
  ): Promise<void> {
    await manager
      .getRepository(Subscription)
      .update({ organizationId }, { usedStorageBytes: value, updatedAt: new Date() });
  }
}
