import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { CursorPage, CursorQuery } from '@app/common';
import { Organization, OrganizationStatus } from './organization.entity';
import type { IOrganizationRepository } from './organization.repository.interface';
import { OrganizationSlugTakenError } from './organization-slug-taken.error';

/** PostgreSQL's error code for a unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';

const DEFAULT_PAGE_SIZE = 20;

/**
 * Injects the raw TypeORM DataSource, NOT TenantAwareDataSource. This is
 * deliberate and specific to this one table: `organizations` is a REGISTRY
 * table (§8.3, §13.8), not RLS-protected, so there is no `app.current_org` to
 * set and no tenant scope to apply. Every OTHER repository in every other
 * service MUST go through TenantAwareDataSource (§13.5) — copying this
 * pattern for an RLS-protected table means app.current_org is never set,
 * and every query silently returns zero rows (fails closed, but silently).
 */
@Injectable()
export class OrganizationRepository implements IOrganizationRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findById(id: string, manager?: EntityManager): Promise<Organization | null> {
    const repo = (manager ?? this.dataSource.manager).getRepository(Organization);
    return repo.findOne({ where: { id } });
  }

  async findBySlug(slug: string, manager?: EntityManager): Promise<Organization | null> {
    const repo = (manager ?? this.dataSource.manager).getRepository(Organization);
    return repo.findOne({ where: { slug } });
  }

  /**
   * §15.5 / §16.4 pattern: no findBySlug() check-then-write here — that shape
   * is a TOCTOU race under concurrent signups with the same organisation name
   * (two requests both read "not taken", both insert). The unique constraint
   * on `slug` (the migration) is the real guarantee; a violation is caught
   * and translated to a typed error the caller can distinguish from any other
   * database failure.
   */
  async create(
    data: { name: string; slug: string },
    manager: EntityManager,
  ): Promise<Organization> {
    const repo = manager.getRepository(Organization);
    const org = repo.create({ ...data, status: OrganizationStatus.PROVISIONING });
    try {
      return await repo.save(org);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new OrganizationSlugTakenError(data.slug);
      }
      throw err;
    }
  }

  async updateStatus(
    id: string,
    status: OrganizationStatus,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = (manager ?? this.dataSource.manager).getRepository(Organization);
    await repo.update({ id }, { status });
  }

  /**
   * §29: keyset pagination by (created_at, id) — constant-time regardless of how
   * many organisations exist, unlike OFFSET which degrades linearly.
   */
  async listPage(query: CursorQuery): Promise<CursorPage<Organization>> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, 100);
    const repo = this.dataSource.getRepository(Organization);

    const qb = repo.createQueryBuilder('org').orderBy('org.createdAt', 'DESC').addOrderBy('org.id', 'DESC').take(limit + 1);

    if (query.cursor) {
      const [cursorCreatedAt, cursorId] = decodeCursor(query.cursor);
      qb.where('(org.createdAt, org.id) < (:cursorCreatedAt, :cursorId)', {
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
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return [createdAt, id];
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
