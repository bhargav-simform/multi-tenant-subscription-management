import type { Plan } from '../models/plan.model';

export interface PlanResponse {
  id: string;
  code: string;
  name: string;
  maxUsers: number;
  maxStorageBytes: number;
}

export function toPlanResponse(plan: Plan): PlanResponse {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    maxUsers: plan.maxUsers,
    maxStorageBytes: plan.maxStorageBytes,
  };
}
