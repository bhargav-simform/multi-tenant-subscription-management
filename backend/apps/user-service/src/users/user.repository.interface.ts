import type { EntityManager } from 'typeorm';
import type { CursorPage, CursorQuery } from '@app/common';
import type { User, UserRole } from './user.entity';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface IUserRepository {
  /** RLS-scoped via TenantAwareDataSource — never returns a foreign-tenant row (§13.5). */
  findById(id: string, manager: EntityManager): Promise<User | null>;
  /** §19.2: counted toward used_seats. Excludes REMOVED users. */
  countActive(organizationId: string, manager: EntityManager): Promise<number>;
  countActiveAdmins(organizationId: string, manager: EntityManager): Promise<number>;
  /**
   * §11.3: `id` is OPTIONAL and, when provided, MUST be honoured as the
   * primary key rather than generating a fresh one — this is how
   * credentials.user_id (minted by auth-service) and users.id end up equal
   * for the SAME identity. Only the OrganizationProvisioned consumer (the
   * first admin user) supplies it; ordinary invitation acceptance lets the
   * database generate one, because that user's identity did not exist
   * before this moment.
   *
   * `organizationId` is EXPLICIT here — the implementation must NOT fall
   * back to ALS tenant context (§13.4) for it. Two callers need this: the
   * OrganizationProvisioned consumer (§13.4 "across Kafka" — ALS is
   * consumer-scoped, so context DOES exist there, but passing it explicitly
   * keeps this method's contract uniform) and invitation acceptance
   * (§19.8 — no ALS scope exists at all until transactionWithDeferredScope's
   * setScope() runs, and this call happens inside that same transaction
   * immediately after).
   */
  create(
    data: {
      id?: string;
      organizationId: string;
      email: string;
      firstName: string;
      lastName: string;
      role: UserRole;
    },
    manager: EntityManager,
  ): Promise<User>;
  markRemoved(id: string, manager: EntityManager): Promise<void>;
  updateRole(id: string, role: UserRole, manager: EntityManager): Promise<void>;
  /** §29: keyset pagination — never OFFSET. RLS-scoped; must run inside a scoped transaction. */
  listPage(query: CursorQuery, manager: EntityManager): Promise<CursorPage<User>>;
  /** §11 dependency: auth-service reads this at login/refresh (§9.2). */
  findRoleByUserId(userId: string): Promise<UserRole | null>;
}
