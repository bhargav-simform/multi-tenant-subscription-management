import type { EntityManager } from 'typeorm';
import type { Plan } from './plan.entity';

export const PLAN_REPOSITORY = Symbol('PLAN_REPOSITORY');

/** §8.5: plans is a GLOBAL table (no RLS) — no tenant scoping to apply here. */
export interface IPlanRepository {
  findAll(): Promise<Plan[]>;
  findByCode(code: string): Promise<Plan | null>;
  findById(id: string, manager?: EntityManager): Promise<Plan | null>;
  /** §8.3: the onboarding saga assigns this as every new org's starting plan. */
  findDefault(): Promise<Plan>;
}
