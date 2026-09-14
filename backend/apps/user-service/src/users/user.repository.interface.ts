import type { EntityManager } from 'typeorm';
import type { CursorPage, CursorQuery } from '@app/common';
import type { User, UserRole } from './user.entity';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface IUserRepository {
  /** RLS-scoped via TenantAwareDataSource — never returns a foreign-tenant row (§13.5). */
  findById(id: string, manager?: EntityManager): Promise<User | null>;
  /** §19.2: counted toward used_seats. Excludes REMOVED users. */
  countActive(organizationId: string, manager: EntityManager): Promise<number>;
  countActiveAdmins(organizationId: string, manager: EntityManager): Promise<number>;
  create(
    data: {
      email: string;
      firstName: string;
      lastName: string;
      role: UserRole;
    },
    manager: EntityManager,
  ): Promise<User>;
  markRemoved(id: string, manager: EntityManager): Promise<void>;
  updateRole(id: string, role: UserRole, manager?: EntityManager): Promise<void>;
  /** §29: keyset pagination — never OFFSET. */
  listPage(query: CursorQuery): Promise<CursorPage<User>>;
  /** §11 dependency: auth-service reads this at login/refresh (§9.2). */
  findRoleByUserId(userId: string): Promise<UserRole | null>;
}
