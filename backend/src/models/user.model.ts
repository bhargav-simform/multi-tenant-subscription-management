import { Prisma } from '../generated/prisma/client';
import type { User as PrismaUser, UserRole, UserStatus } from '../generated/prisma/client';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import type { Tx } from '../lib/tenant-db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type CursorPage } from '../types/pagination';

export type { UserRole, UserStatus };

export interface User {
  id: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateUserData {
  /** Honoured as the primary key when given, so users.id equals the credential's user_id. */
  id?: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
}

export function toUser(row: PrismaUser): User {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** RLS-scoped: a foreign-tenant id is indistinguishable from a missing one. */
export async function findById(db: Tx, organizationId: string, id: string): Promise<User | null> {
  const row = await db.user.findFirst({ where: { id, organizationId, deletedAt: null } });
  return row ? toUser(row) : null;
}

export async function countActive(db: Tx, organizationId: string): Promise<number> {
  return db.user.count({ where: { organizationId, status: 'active', deletedAt: null } });
}

export async function countActiveAdmins(db: Tx, organizationId: string): Promise<number> {
  return db.user.count({
    where: { organizationId, status: 'active', role: 'org_admin', deletedAt: null },
  });
}

export async function create(db: Tx, data: CreateUserData): Promise<User> {
  return toUser(await db.user.create({ data }));
}

/** Soft removal: the row survives for audit; a removed user holds no seat. */
export async function markRemoved(db: Tx, organizationId: string, id: string): Promise<void> {
  await db.user.updateMany({ where: { id, organizationId }, data: { status: 'removed' } });
}

export async function updateRole(
  db: Tx,
  organizationId: string,
  id: string,
  role: UserRole,
): Promise<void> {
  await db.user.updateMany({ where: { id, organizationId }, data: { role } });
}

interface UserRow {
  id: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Keyset pagination on (created_at DESC, id DESC), never OFFSET. Raw SQL so the
 * cursor values reach Postgres as the same row-comparison `(created_at, id) < (..)`
 * the old query used, with Postgres (not JS) parsing them.
 */
export async function listPage(
  db: Tx,
  organizationId: string,
  query: { cursor?: string; limit?: number },
): Promise<CursorPage<User>> {
  const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  let cursorFilter = Prisma.empty;
  if (query.cursor) {
    const [cursorCreatedAt, cursorId] = decodeCursor(query.cursor);
    cursorFilter = Prisma.sql`AND (created_at, id) < (${cursorCreatedAt ?? null}::timestamptz, ${cursorId ?? null}::uuid)`;
  }

  const rows = await db.$queryRaw<UserRow[]>`
    SELECT id, organization_id AS "organizationId", email::text AS email, first_name AS "firstName",
           last_name AS "lastName", role::text AS role, status::text AS status,
           created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"
    FROM users
    WHERE organization_id = ${organizationId}::uuid
      AND status <> 'removed'
      AND deleted_at IS NULL
      ${cursorFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
  };
}

/**
 * SECURITY DEFINER lookup: the owning org of a user id, and nothing else. Used
 * unscoped, before any tenant context exists (the auth role lookup).
 */
export async function findOrganizationIdForUser(db: Tx, userId: string): Promise<string | null> {
  const rows = await db.$queryRaw<{ get_user_organization_id: string | null }[]>`
    SELECT get_user_organization_id(${userId}::uuid)
  `;
  return rows[0]?.get_user_organization_id ?? null;
}

/** RLS-scoped (the caller's transaction is scoped to the user's own org). */
export async function findNonRemovedRole(db: Tx, userId: string): Promise<UserRole | null> {
  const row = await db.user.findFirst({
    where: { id: userId, status: { not: 'removed' }, deletedAt: null },
    select: { role: true },
  });
  return row?.role ?? null;
}

/** SECURITY DEFINER probe: whether the id exists in ANY org. Returns only a boolean. */
export async function existsInAnyOrganization(db: Tx, userId: string): Promise<boolean> {
  const rows = await db.$queryRaw<
    { user_exists: boolean | null }[]
  >`SELECT user_exists(${userId}::uuid)`;
  return rows[0]?.user_exists ?? false;
}
