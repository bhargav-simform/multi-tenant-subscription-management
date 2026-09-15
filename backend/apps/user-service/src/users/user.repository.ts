import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { CursorPage, CursorQuery } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import { TenantAwareDataSource, TenantRepository } from '@app/database';
import { User, UserRole, UserStatus } from './user.entity';
import type { IUserRepository } from './user.repository.interface';

const DEFAULT_PAGE_SIZE = 20;

/**
 * §13.5: extends TenantRepository, so every read/write is scoped to
 * organizationId as a matter of application code — RLS is the structural
 * guarantee underneath (§13.5's "second mechanism"), this is the readable
 * defence-in-depth layer on top of it.
 */
@Injectable()
export class UserRepository extends TenantRepository<User> implements IUserRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantAwareDataSource: TenantAwareDataSource,
    tenantContext: TenantContextStore,
  ) {
    super(tenantContext);
  }

  protected get repository() {
    return this.dataSource.getRepository(User);
  }

  async findById(id: string, manager?: EntityManager): Promise<User | null> {
    const repo = manager ? manager.getRepository(User) : this.repository;
    return repo.findOne({ where: { id, organizationId: this.organizationId } });
  }

  async countActive(organizationId: string, manager: EntityManager): Promise<number> {
    return manager.getRepository(User).count({
      where: { organizationId, status: UserStatus.ACTIVE },
    });
  }

  async countActiveAdmins(organizationId: string, manager: EntityManager): Promise<number> {
    return manager.getRepository(User).count({
      where: { organizationId, status: UserStatus.ACTIVE, role: UserRole.ORG_ADMIN },
    });
  }

  async create(
    data: {
      id?: string;
      organizationId: string;
      email: string;
      firstName: string;
      lastName: string;
      role: UserRole;
    },
    manager: EntityManager,
  ): Promise<User> {
    const repo = manager.getRepository(User);
    const user = repo.create(data);
    return repo.save(user);
  }

  async markRemoved(id: string, manager: EntityManager): Promise<void> {
    await manager
      .getRepository(User)
      .update({ id, organizationId: this.organizationId }, { status: UserStatus.REMOVED });
  }

  async updateRole(id: string, role: UserRole, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(User) : this.repository;
    await repo.update({ id, organizationId: this.organizationId }, { role });
  }

  /** §29: keyset pagination — never OFFSET. */
  async listPage(query: CursorQuery): Promise<CursorPage<User>> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, 100);
    const qb = this.repository
      .createQueryBuilder('u')
      .where('u.organizationId = :organizationId', { organizationId: this.organizationId })
      .andWhere("u.status <> 'removed'")
      .orderBy('u.createdAt', 'DESC')
      .addOrderBy('u.id', 'DESC')
      .take(limit + 1);

    if (query.cursor) {
      const [cursorCreatedAt, cursorId] = decodeCursor(query.cursor);
      qb.andWhere('(u.createdAt, u.id) < (:cursorCreatedAt, :cursorId)', {
        cursorCreatedAt,
        cursorId,
      });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);

    return {
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /**
   * §9.2, §11.2: called by auth-service (via HTTP, not directly) at
   * login/refresh, before any tenant context can be established — the
   * caller does not know (and must not need to know) the user's
   * organisation ahead of time.
   *
   * Because users.users has FORCE ROW LEVEL SECURITY, a query with no
   * matching app.current_org returns ZERO ROWS UNCONDITIONALLY for app_user
   * (§13.5) — there is no way to "just query by id" through the normal path.
   * This is deliberately two steps, both auditable, neither a general bypass:
   *   1. users.get_user_organization_id(uuid) — a SECURITY DEFINER SQL
   *      function created in this service's migration, owned by
   *      app_migrator, granted EXECUTE to app_user. It returns EXACTLY ONE
   *      COLUMN (organization_id) and cannot be used to read anything else —
   *      it is not a general RLS bypass, only this one narrow lookup.
   *   2. A NORMAL RLS-scoped query, with app.current_org now set to the
   *      value step 1 found, re-reads the row for `role` (and applies the
   *      `status <> 'removed'` filter). NOTE: because this reads the SAME
   *      row by the SAME id, using an organizationId derived from that very
   *      row, the RLS policy here cannot meaningfully fail — this step does
   *      not "re-verify" step 1's answer, it simply fetches a column step 1
   *      does not expose (get_user_organization_id() returns only
   *      organization_id). The real reason for two steps is §13.6's rule
   *      that the SECURITY DEFINER function must expose exactly one column
   *      and nothing more, not a double-check of correctness.
   */
  async findRoleByUserId(userId: string): Promise<UserRole | null> {
    const organizationId = await this.tenantAwareDataSource.runGlobal(async (manager) => {
      const row = await manager.query<{ get_user_organization_id: string | null }[]>(
        `SELECT users.get_user_organization_id($1)`,
        [userId],
      );
      return row[0]?.get_user_organization_id ?? null;
    });
    if (!organizationId) return null;

    return this.tenantAwareDataSource.transactionForOrganization(organizationId, async (manager) => {
      const row = await manager
        .getRepository(User)
        .createQueryBuilder('u')
        .select('u.role', 'role')
        .where('u.id = :userId', { userId })
        .andWhere("u.status <> 'removed'")
        .getRawOne<{ role: UserRole }>();
      return row?.role ?? null;
    });
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return [createdAt, id];
}
