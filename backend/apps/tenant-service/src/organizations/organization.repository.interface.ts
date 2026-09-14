import type { EntityManager } from 'typeorm';
import type { Organization, OrganizationStatus } from './organization.entity';
import type { CursorPage, CursorQuery } from '@app/common';

export const ORGANIZATION_REPOSITORY = Symbol('ORGANIZATION_REPOSITORY');

/**
 * §20.2: the application service depends on this interface, never on
 * Repository<Organization> directly — organizations is a global table (§8.3),
 * so this repository does NOT extend TenantRepository (there is no tenant scope
 * to apply; every org reads its own row by id, platform admins read all rows).
 */
export interface IOrganizationRepository {
  findById(id: string, manager?: EntityManager): Promise<Organization | null>;
  /**
   * READ-ONLY / DIAGNOSTIC USE ONLY (e.g. a future "check availability while
   * typing" endpoint). MUST NEVER precede a call to create() — that
   * check-then-write shape is the exact TOCTOU race under concurrent signups
   * that create() now closes by catching the unique-constraint violation
   * instead (§15.5, §16.4). onboarding.service.ts does not call this.
   */
  findBySlug(slug: string, manager?: EntityManager): Promise<Organization | null>;
  create(data: { name: string; slug: string }, manager: EntityManager): Promise<Organization>;
  updateStatus(id: string, status: OrganizationStatus, manager?: EntityManager): Promise<void>;
  /** §29: keyset pagination for the platform-admin org list — never OFFSET. */
  listPage(query: CursorQuery): Promise<CursorPage<Organization>>;
}
