import { InternalServerErrorException } from '../lib/http-errors';
import { runGlobal } from '../lib/tenant-db';
import * as plans from '../models/plan.model';
import type { Plan } from '../models/plan.model';

export async function listActive(): Promise<Plan[]> {
  return runGlobal((tx) => plans.findAllActive(tx));
}

export async function findByCode(code: string): Promise<Plan | null> {
  return runGlobal((tx) => plans.findByCode(tx, code));
}

/** New organisations start on free. Its absence means the migration's seed never ran. */
export async function findDefault(): Promise<Plan> {
  const plan = await findByCode('free');
  if (!plan) {
    throw new InternalServerErrorException('Default plan (free) not found — seed data missing');
  }
  return plan;
}
