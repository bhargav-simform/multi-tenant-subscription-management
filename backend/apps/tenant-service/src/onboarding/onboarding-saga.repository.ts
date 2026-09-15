import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OnboardingSaga, SagaState } from './onboarding-saga.entity';

export const ONBOARDING_SAGA_REPOSITORY = Symbol('ONBOARDING_SAGA_REPOSITORY');

export interface IOnboardingSagaRepository {
  findByIdempotencyKey(key: string, manager?: EntityManager): Promise<OnboardingSaga | null>;
  create(
    data: { idempotencyKey: string; adminEmail: string },
    manager: EntityManager,
  ): Promise<OnboardingSaga>;
  /**
   * Records a successful step. ALWAYS moves `state` forward and clears any
   * prior failure — this is the only method that changes `state`.
   */
  advance(
    id: string,
    state: SagaState,
    patch: Partial<Pick<OnboardingSaga, 'organizationId' | 'adminUserId'>>,
    manager: EntityManager,
  ): Promise<void>;
  /**
   * Records a failed attempt WITHOUT touching `state` (§30.1: "the saga
   * records the state reached" — state already holds that; failure adds
   * lastError + failedAt alongside it, so the next retry's resume logic sees
   * exactly the state it left off at).
   */
  markFailed(id: string, error: string, manager: EntityManager): Promise<void>;
}

/**
 * Raw DataSource, not TenantAwareDataSource — onboarding_sagas is a REGISTRY
 * table (§8.3, §13.8), not RLS-protected. See organization.repository.ts for
 * the full explanation; do not copy this pattern for an RLS-protected table.
 */
@Injectable()
export class OnboardingSagaRepository implements IOnboardingSagaRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findByIdempotencyKey(
    key: string,
    manager?: EntityManager,
  ): Promise<OnboardingSaga | null> {
    const repo = (manager ?? this.dataSource.manager).getRepository(OnboardingSaga);
    return repo.findOne({ where: { idempotencyKey: key } });
  }

  async create(
    data: { idempotencyKey: string; adminEmail: string },
    manager: EntityManager,
  ): Promise<OnboardingSaga> {
    const repo = manager.getRepository(OnboardingSaga);
    const saga = repo.create({ ...data, state: SagaState.PENDING, attempts: 0 });
    return repo.save(saga);
  }

  async advance(
    id: string,
    state: SagaState,
    patch: Partial<Pick<OnboardingSaga, 'organizationId' | 'adminUserId'>>,
    manager: EntityManager,
  ): Promise<void> {
    const repo = manager.getRepository(OnboardingSaga);
    await repo.increment({ id }, 'attempts', 1);
    await repo.update({ id }, { state, failedAt: null, lastError: null, ...patch });
  }

  async markFailed(id: string, error: string, manager: EntityManager): Promise<void> {
    const repo = manager.getRepository(OnboardingSaga);
    await repo.increment({ id }, 'attempts', 1);
    await repo.update({ id }, { lastError: error, failedAt: new Date() });
  }
}
