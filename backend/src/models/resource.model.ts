import { Prisma, type Resource as PrismaResource } from '../generated/prisma/client';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import type { Tx } from '../lib/tenant-db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type CursorPage } from '../types/pagination';

export const RESOURCE_SORT = {
  CREATED_AT: 'createdAt',
  SIZE_BYTES: 'sizeBytes',
} as const;

export type ResourceSort = (typeof RESOURCE_SORT)[keyof typeof RESOURCE_SORT];

export interface Resource {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  sizeBytes: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateResourceData {
  organizationId: string;
  name: string;
  description: string | null;
  sizeBytes: number;
  createdBy: string;
}

export interface ResourcePageQuery {
  cursor?: string;
  limit?: number;
  sort?: ResourceSort;
  hasDescription?: string;
}

/** What a raw `SELECT * FROM resources` yields: snake_case columns, bigint as bigint. */
export interface RawResourceRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  size_bytes: bigint;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

function toResource(row: PrismaResource): Resource {
  return { ...row, sizeBytes: Number(row.sizeBytes) };
}

export function rawToResource(row: RawResourceRow): Resource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    sizeBytes: Number(row.size_bytes),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export async function create(db: Tx, data: CreateResourceData): Promise<Resource> {
  const row = await db.resource.create({ data: { ...data, sizeBytes: BigInt(data.sizeBytes) } });
  return toResource(row);
}

/** Scoped by organizationId here and by RLS underneath: a foreign id is indistinguishable from a missing one. */
export async function findById(
  db: Tx,
  id: string,
  organizationId: string,
): Promise<Resource | null> {
  const row = await db.resource.findFirst({ where: { id, organizationId, deletedAt: null } });
  return row ? toResource(row) : null;
}

/**
 * Keyset page ordered by the sort column DESC, then id DESC. The cursor encodes
 * (sortValue, id) for whichever column is active; a cursor minted under another sort
 * has no meaning here (the frontend resets pagination when sort changes).
 */
export async function listPage(
  db: Tx,
  organizationId: string,
  query: ResourcePageQuery,
): Promise<CursorPage<Resource>> {
  const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const bySize = (query.sort ?? RESOURCE_SORT.CREATED_AT) === RESOURCE_SORT.SIZE_BYTES;
  const sortColumn = bySize ? Prisma.raw('size_bytes') : Prisma.raw('created_at');

  const conditions: Prisma.Sql[] = [
    Prisma.sql`organization_id = ${organizationId}::uuid`,
    Prisma.sql`deleted_at IS NULL`,
  ];
  if (query.hasDescription === 'false') {
    conditions.push(Prisma.sql`(description IS NULL OR description = '')`);
  } else if (query.hasDescription === 'true') {
    conditions.push(Prisma.sql`description IS NOT NULL AND description != ''`);
  }
  if (query.cursor) {
    const [cursorSortValue, cursorId] = decodeCursor(query.cursor);
    const cursorValue = bySize
      ? Prisma.sql`${cursorSortValue}::bigint`
      : Prisma.sql`${cursorSortValue}::timestamptz`;
    conditions.push(Prisma.sql`(${sortColumn}, id) < (${cursorValue}, ${cursorId}::uuid)`);
  }

  const rows = await db.$queryRaw<RawResourceRow[]>`
    SELECT * FROM resources
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY ${sortColumn} DESC, id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(rawToResource);
  const last = items.at(-1);
  const lastSortValue = last
    ? bySize
      ? String(last.sizeBytes)
      : last.createdAt.toISOString()
    : '';
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(lastSortValue, last.id) : null,
  };
}

/** Drift detection only — never on the create/delete hot path (the locked counter is authoritative). */
export async function sumSizeBytesForOrg(db: Tx, organizationId: string): Promise<number> {
  const result = await db.resource.aggregate({
    where: { organizationId, deletedAt: null },
    _sum: { sizeBytes: true },
  });
  return Number(result._sum.sizeBytes ?? 0);
}

/** Soft delete, like users: the row survives for audit but no longer counts. */
export async function remove(db: Tx, id: string, organizationId: string): Promise<void> {
  await db.resource.updateMany({ where: { id, organizationId }, data: { deletedAt: new Date() } });
}

/**
 * DELIBERATELY CARELESS — no tenant filter at all, and it must stay that way. It is
 * the executable proof that RLS alone scopes a raw WHERE-less query to the current
 * organisation. Do not add a filter.
 */
export async function findAllResourcesForReport(db: Tx): Promise<RawResourceRow[]> {
  return db.$queryRaw<RawResourceRow[]>`SELECT * FROM resources`;
}
