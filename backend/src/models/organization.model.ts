import {
  Prisma,
  type Organization as PrismaOrganization,
  type OrganizationStatus,
} from '../generated/prisma/client';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { isUniqueViolation } from '../lib/db-errors';
import type { Tx } from '../lib/tenant-db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type CursorPage } from '../types/pagination';

export type { OrganizationStatus };

/**
 * organizations — the tenant registry itself, not tenant content, so no RLS.
 * Metadata only (name, slug, status): that is why a platform admin can list it
 * without seeing any tenant data.
 */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Thrown by create() when the unique constraint on `slug` is violated. */
export class OrganizationSlugTakenError extends Error {
  constructor(slug: string) {
    super(`Organization slug "${slug}" is already taken`);
    this.name = 'OrganizationSlugTakenError';
  }
}

function toOrganization(row: PrismaOrganization): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function findById(db: Tx, id: string): Promise<Organization | null> {
  const row = await db.organization.findUnique({ where: { id } });
  return row ? toOrganization(row) : null;
}

/** Read-only/diagnostic. Must never precede create() — that is the TOCTOU create() avoids. */
export async function findBySlug(db: Tx, slug: string): Promise<Organization | null> {
  const row = await db.organization.findUnique({ where: { slug } });
  return row ? toOrganization(row) : null;
}

/** The unique constraint on slug is the guarantee under concurrent signups. */
export async function create(db: Tx, data: { name: string; slug: string }): Promise<Organization> {
  try {
    return toOrganization(
      await db.organization.create({ data: { ...data, status: 'provisioning' } }),
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new OrganizationSlugTakenError(data.slug);
    }
    throw err;
  }
}

export async function updateStatus(db: Tx, id: string, status: OrganizationStatus): Promise<void> {
  await db.organization.updateMany({ where: { id }, data: { status } });
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  created_at: Date;
  updated_at: Date;
}

/**
 * Keyset pagination by (created_at, id) DESC — never OFFSET. A row-value comparison
 * in raw SQL, exactly as before; a malformed cursor fails in Postgres (500).
 */
export async function listPage(
  db: Tx,
  query: { cursor?: string; limit?: number },
): Promise<CursorPage<Organization>> {
  const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  let where = Prisma.empty;
  if (query.cursor) {
    const [cursorCreatedAt, cursorId] = decodeCursor(query.cursor);
    where = Prisma.sql`WHERE (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)`;
  }

  const rows = await db.$queryRaw<OrganizationRow[]>`
    SELECT id, name, slug, status, created_at, updated_at
    FROM organizations
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
  };
}
