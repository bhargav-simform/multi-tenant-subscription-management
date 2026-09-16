import type { EntityManager } from 'typeorm';
import type { CursorPage, CursorQuery } from '@app/common';
import type { Resource } from './resource.entity';

export const RESOURCE_REPOSITORY = Symbol('RESOURCE_REPOSITORY');

/**
 * The shape a raw `SELECT * FROM resources` actually yields: snake_case
 * columns straight from the pg driver, with bigint as a string (§15.1 — the
 * entity's bigintTransformer does not apply to an unmapped raw query).
 */
export interface RawResourceRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  size_bytes: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface CreateResourceData {
  name: string;
  description: string | null;
  sizeBytes: number;
  createdBy: string;
}

/**
 * §20.2: the domain declares this interface; the TypeORM implementation is
 * bound to the token above in resources.module.ts. Every method requires an
 * EntityManager from an ALREADY-OPEN, TenantAwareDataSource-scoped
 * transaction (§32.4) — `resources` has FORCE ROW LEVEL SECURITY, so a query
 * on a connection with no `app.current_org` set returns zero rows
 * UNCONDITIONALLY, for every organisation, not just a foreign one. Requiring
 * the manager makes a missing scope a compile error rather than a silent
 * empty result.
 */
export interface IResourceRepository {
  create(data: CreateResourceData, manager: EntityManager): Promise<Resource>;

  /** §13, H1: the cross-tenant read-by-id target. RLS-scoped; a foreign id yields null. */
  findById(id: string, manager: EntityManager): Promise<Resource | null>;

  /** §29: keyset pagination on (created_at DESC, id) — never OFFSET. */
  listPage(query: CursorQuery, manager: EntityManager): Promise<CursorPage<Resource>>;

  /**
   * §19.4 "drift detection": recomputes the true total from the rows
   * themselves. This is NOT the enforcement path — enforcement reads the
   * authoritative `plan_limit_cache.used_storage_bytes` counter under its row
   * lock (§19.6). This method exists to detect a counter that has drifted
   * from its rows, which is evidence of a code path that skipped the lock.
   * Never call it on the create/delete hot path.
   */
  sumSizeBytesForOrg(organizationId: string, manager: EntityManager): Promise<number>;

  /** Soft delete (sets deleted_at) — see the implementation for why, not hard delete. */
  remove(id: string, manager: EntityManager): Promise<void>;

  /**
   * §13.1's CENTRAL CLAIM, kept executable. A deliberately careless raw query
   * with NO tenant filter whatsoever. It is not a bug and must never be
   * "fixed" — see the implementation's comment.
   *
   * Returns RAW DATABASE ROWS (snake_case columns, bigint as string), not
   * mapped `Resource` entities — because it is a raw `SELECT *` that bypasses
   * TypeORM's mapping entirely. That is precisely the point: the query under
   * test is the careless one a developer would actually write, not an
   * ORM-mediated one, and RLS must protect it just the same.
   */
  findAllResourcesForReport(manager: EntityManager): Promise<RawResourceRow[]>;
}
