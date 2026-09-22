import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { CursorPage } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import { TenantRepository } from '@app/database';
import { Resource } from './resource.entity';
import { RESOURCE_SORT, type ListResourcesQueryDto } from './dto/list-resources-query.dto';
import type {
  CreateResourceData,
  IResourceRepository,
  RawResourceRow,
} from './resource.repository.interface';

/** The DB column each sort mode orders and cursors by — id is always the tiebreaker. */
const SORT_COLUMN: Record<string, string> = {
  [RESOURCE_SORT.CREATED_AT]: 'createdAt',
  [RESOURCE_SORT.SIZE_BYTES]: 'sizeBytes',
};

const DEFAULT_PAGE_SIZE = 20;

/**
 * §13.5: extends TenantRepository, so every read/write is scoped to
 * organizationId as a matter of readable application code — RLS is the
 * structural guarantee underneath ("second mechanism"), this is the
 * defence-in-depth layer on top. Every method takes a REQUIRED `manager` from
 * a TenantAwareDataSource-scoped transaction (§32.4); there is deliberately
 * no fallback to a raw, unscoped DataSource anywhere in this service.
 */
@Injectable()
export class ResourceRepository extends TenantRepository<Resource> implements IResourceRepository {
  protected readonly entityTarget = Resource;

  constructor(tenantContext: TenantContextStore) {
    super(tenantContext);
  }

  async create(data: CreateResourceData, manager: EntityManager): Promise<Resource> {
    const repo = manager.getRepository(Resource);
    const resource = repo.create({
      organizationId: this.organizationId,
      name: data.name,
      description: data.description,
      sizeBytes: data.sizeBytes,
      createdBy: data.createdBy,
    });
    return repo.save(resource);
  }

  /**
   * §13, H1. Scoped by organizationId here AND by RLS underneath. A
   * foreign-tenant id returns null identically to a nonexistent one — this
   * method has no way to distinguish them, which is the point (§13.9).
   */
  async findById(id: string, manager: EntityManager): Promise<Resource | null> {
    return manager
      .getRepository(Resource)
      .findOne({ where: { id, organizationId: this.organizationId } });
  }

  /**
   * §29: keyset pagination — never OFFSET. Orders by `query.sort` (default
   * createdAt) DESC, then id DESC as a tiebreaker. The cursor encodes
   * (sortColumnValue, id) for WHICHEVER column is active — switching sort
   * mid-session means starting a fresh cursor, since a cursor minted under one
   * ordering has no meaning under another; the frontend resets pagination
   * whenever the active sort/filter changes, so this never sees a cursor
   * encoded for a different sort than the one it was given.
   */
  async listPage(query: ListResourcesQueryDto, manager: EntityManager): Promise<CursorPage<Resource>> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, 100);
    const sortColumn = SORT_COLUMN[query.sort ?? RESOURCE_SORT.CREATED_AT];

    const qb = manager
      .getRepository(Resource)
      .createQueryBuilder('r')
      .where('r.organizationId = :organizationId', { organizationId: this.organizationId })
      .orderBy(`r.${sortColumn}`, 'DESC')
      .addOrderBy('r.id', 'DESC')
      .take(limit + 1);

    // Server-side only, never a client-side filter over one already-loaded
    // page — this list is keyset paginated, so filtering only the current
    // page would silently hide matches sitting on pages not yet fetched.
    if (query.hasDescription === 'false') {
      qb.andWhere('(r.description IS NULL OR r.description = :empty)', { empty: '' });
    } else if (query.hasDescription === 'true') {
      qb.andWhere('r.description IS NOT NULL').andWhere("r.description != ''");
    }

    if (query.cursor) {
      const [cursorSortValue, cursorId] = decodeCursor(query.cursor);
      qb.andWhere(`(r.${sortColumn}, r.id) < (:cursorSortValue, :cursorId)`, {
        cursorSortValue,
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
      nextCursor: hasMore && last ? encodeCursor(sortColumnValue(last, sortColumn), last.id) : null,
    };
  }

  /**
   * §19.4 "drift detection" — NOT the enforcement path. See the interface's
   * doc comment: enforcement reads plan_limit_cache.used_storage_bytes under
   * that row's lock, because that is the column the CHECK constraint guards.
   * Excludes soft-deleted rows so it recomputes the same quantity the counter
   * tracks.
   */
  async sumSizeBytesForOrg(organizationId: string, manager: EntityManager): Promise<number> {
    const row = await manager
      .getRepository(Resource)
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.size_bytes), 0)', 'total')
      .where('r.organizationId = :organizationId', { organizationId })
      .andWhere('r.deletedAt IS NULL')
      .getRawOne<{ total: string }>();
    // SUM() over a bigint column comes back as a string from the pg driver
    // (§15.1) — the entity's bigintTransformer does not apply to a raw
    // aggregate, so the conversion is explicit here.
    return Number(row?.total ?? 0);
  }

  /**
   * SOFT delete (sets deleted_at via TenantBaseEntity's @DeleteDateColumn),
   * consistent with user-service's `markRemoved`: that service also keeps the
   * row and marks it rather than hard-deleting, so the record survives for
   * audit. The row no longer counts toward storage — every read path here
   * goes through TypeORM's repository API, which excludes soft-deleted rows
   * automatically, and `sumSizeBytesForOrg` filters `deleted_at IS NULL`
   * explicitly to match.
   *
   * Scoped by organizationId as well as by RLS: a foreign-tenant id updates
   * zero rows rather than erroring, and the caller has already 404'd on the
   * RLS-scoped read before reaching here.
   */
  async remove(id: string, manager: EntityManager): Promise<void> {
    await manager
      .getRepository(Resource)
      .softDelete({ id, organizationId: this.organizationId });
  }

  /**
   * §13.1 — THE CENTRAL CLAIM OF THIS ARCHITECTURE, KEPT EXECUTABLE.
   *
   * THIS METHOD IS DELIBERATELY CARELESS AND MUST STAY THAT WAY. It is the
   * literal code example from ARCHITECTURE.md §13.1: "A new developer writes
   * this. No tenant filter anywhere." — a raw SQL query with no WHERE clause
   * at all, no organization_id, no scoping of any kind in application code.
   *
   * DO NOT ADD A TENANT FILTER HERE. Doing so would destroy the only
   * executable proof that the isolation guarantee is structural rather than a
   * discipline every engineer must remember. The claim being proven is that
   * this query returns ONLY the current tenant's rows anyway, because
   * PostgreSQL applies the row-level security policy to raw SQL before
   * returning it — the developer's omission produces no leak, and cannot,
   * because the filter is not in the application at all.
   *
   * The proof itself lives in
   * test/integration/resource-service/rls-isolation.integration.spec.ts, which
   * seeds two organisations and asserts only one org's rows come back. If
   * that test is ever deleted or skipped, the architecture's central claim is
   * unverified (§13.8 check #3).
   *
   * The `manager` parameter is required for the same reason every other
   * method here requires one — it must come from a scoped transaction, which
   * is what sets `app.current_org` for the policy to read. That is the ONLY
   * thing standing between this query and a full cross-tenant dump.
   */
  async findAllResourcesForReport(manager: EntityManager): Promise<RawResourceRow[]> {
    return manager.query<RawResourceRow[]>('SELECT * FROM resources');
  }
}

/** The active sort column's value off a row, stringified the same way for both a Date (createdAt) and a number (sizeBytes). */
function sortColumnValue(row: Resource, column: string): string {
  const value = (row as unknown as Record<string, unknown>)[column];
  return value instanceof Date ? value.toISOString() : String(value);
}

function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(`${sortValue}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  const [sortValue, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return [sortValue, id];
}
