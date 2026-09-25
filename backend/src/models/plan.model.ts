import type { Plan as PrismaPlan, PlanCode } from '../generated/prisma/client';
import type { Tx } from '../lib/tenant-db';

export type { PlanCode };

/** A plan with bigint columns as JS numbers (precision loss above 2^53 accepted, as before). */
export interface Plan {
  id: string;
  code: PlanCode;
  name: string;
  maxUsers: number;
  maxStorageBytes: number;
  isActive: boolean;
}

export function toPlan(row: PrismaPlan): Plan {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    maxUsers: row.maxUsers,
    maxStorageBytes: Number(row.maxStorageBytes),
    isActive: row.isActive,
  };
}

/** plans is global reference data (no RLS): any transaction, scoped or not, sees it. */
export async function findAllActive(db: Tx): Promise<Plan[]> {
  return (await db.plan.findMany({ where: { isActive: true } })).map(toPlan);
}

export async function findByCode(db: Tx, code: string): Promise<Plan | null> {
  const row = await db.plan.findFirst({ where: { code: code as PlanCode } });
  return row ? toPlan(row) : null;
}

export async function findById(db: Tx, id: string): Promise<Plan | null> {
  const row = await db.plan.findUnique({ where: { id } });
  return row ? toPlan(row) : null;
}
