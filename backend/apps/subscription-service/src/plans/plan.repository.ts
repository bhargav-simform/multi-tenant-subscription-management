import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { TenantAwareDataSource } from '@app/database';
import { Plan, PlanCode } from './plan.entity';
import type { IPlanRepository } from './plan.repository.interface';

/**
 * §13.7 row 4, §15.3: `subs.plans` is a GLOBAL table (no RLS) — there is no
 * tenant to scope this to. Still routed through `TenantAwareDataSource.runGlobal()`,
 * never a raw injected `DataSource`, so this service has exactly ONE database
 * entry point (§32.4 records the defect class this avoids: a raw `DataSource`
 * read silently returning nothing under RLS elsewhere in this codebase).
 */
@Injectable()
export class PlanRepository implements IPlanRepository {
  constructor(private readonly tenantDataSource: TenantAwareDataSource) {}

  async findAll(): Promise<Plan[]> {
    return this.tenantDataSource.runGlobal((manager) =>
      manager.getRepository(Plan).find({ where: { isActive: true } }),
    );
  }

  async findByCode(code: string): Promise<Plan | null> {
    return this.tenantDataSource.runGlobal((manager) =>
      manager.getRepository(Plan).findOne({ where: { code: code as PlanCode } }),
    );
  }

  async findById(id: string, manager?: EntityManager): Promise<Plan | null> {
    if (manager) return manager.getRepository(Plan).findOne({ where: { id } });
    return this.tenantDataSource.runGlobal((m) => m.getRepository(Plan).findOne({ where: { id } }));
  }

  async findDefault(): Promise<Plan> {
    const plan = await this.findByCode(PlanCode.FREE);
    if (!plan) {
      // §8.3: onboarding cannot proceed without a default plan to assign —
      // a missing seed row is a deployment bug, not a normal 404.
      throw new InternalServerErrorException('Default plan (free) not found — seed data missing');
    }
    return plan;
  }
}
