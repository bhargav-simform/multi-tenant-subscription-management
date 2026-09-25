import { contextStore } from '../lib/context-store';
import { publish } from '../lib/events';
import {
  ForbiddenException,
  NotFoundException,
  PlanLimitExceededException,
} from '../lib/http-errors';
import { createLogger } from '../lib/logger';
import { runGlobal, transaction } from '../lib/tenant-db';
import * as planLimits from '../models/plan-limit-cache.model';
import * as resources from '../models/resource.model';
import type { Resource, ResourcePageQuery } from '../models/resource.model';
import { Role } from '../types/constants';
import { EVENT_TYPES, TOPICS, type EventType } from '../types/events';
import type { CursorPage } from '../types/pagination';

const logger = createLogger('ResourcesService');

export interface CreateResourceInput {
  name: string;
  description?: string;
  sizeBytes: number;
}

/**
 * The storage-limit path: lock plan_limit_cache FIRST, check the authoritative
 * counter read under that lock (never SUM() over rows), insert and increment in the
 * same transaction, publish after commit. A 409 rolls everything back.
 */
export async function create(input: CreateResourceInput): Promise<Resource> {
  const ctx = contextStore.getOrThrow();
  const organizationId = ctx.organizationId as string;
  const createdBy = ctx.userId as string;

  const resource = await transaction(async (tx) => {
    const storage = await planLimits.lockForUpdate(tx, organizationId);

    const projected = storage.usedStorageBytes + input.sizeBytes;
    if (projected > storage.maxStorageBytes) {
      const remaining = Math.max(0, storage.maxStorageBytes - storage.usedStorageBytes);
      throw new PlanLimitExceededException(
        {
          limitType: 'storage',
          limit: storage.maxStorageBytes,
          current: storage.usedStorageBytes,
          // plan_limit_cache holds only the ceiling, not which plan produced it.
          planCode: 'unknown',
        },
        `This resource needs ${formatBytes(input.sizeBytes)}, but only ` +
          `${formatBytes(remaining)} of your ${formatBytes(storage.maxStorageBytes)} storage ` +
          `limit remains (${formatBytes(storage.usedStorageBytes)} in use). ` +
          `Delete an existing resource or upgrade your plan to add more.`,
      );
    }

    const created = await resources.create(tx, {
      organizationId,
      name: input.name,
      description: input.description ?? null,
      sizeBytes: input.sizeBytes,
      createdBy,
    });
    await planLimits.adjustUsedStorageBytes(tx, organizationId, input.sizeBytes);
    return created;
  });

  // sizeDelta is what storage-reconciliation reads to maintain the display counter.
  await publishEvent(organizationId, EVENT_TYPES.RESOURCE_CREATED, {
    resourceId: resource.id,
    name: resource.name,
    sizeDelta: resource.sizeBytes,
  });

  return resource;
}

/**
 * A foreign-tenant id gets exactly the same 404 as a missing one; the cross-tenant
 * probe only decides whether to emit a security event.
 */
export async function getById(id: string): Promise<Resource> {
  const ctx = contextStore.getOrThrow();
  const resource = await transaction((tx) =>
    resources.findById(tx, id, ctx.organizationId as string),
  );

  if (!resource) {
    await reportIfCrossTenantAttempt(id);
    throw new NotFoundException();
  }
  return resource;
}

export async function listPage(query: ResourcePageQuery): Promise<CursorPage<Resource>> {
  const ctx = contextStore.getOrThrow();
  return transaction((tx) => resources.listPage(tx, ctx.organizationId as string, query));
}

/**
 * Frees storage with the same lock-then-write ordering as create(). 404 (with the
 * cross-tenant probe) when the scoped read finds nothing; 403 when a member targets
 * someone else's resource — the ownership condition needs the loaded row, so it is
 * checked here rather than by authorize().
 */
export async function remove(id: string): Promise<void> {
  const ctx = contextStore.getOrThrow();
  const organizationId = ctx.organizationId as string;

  const removed = await transaction(async (tx) => {
    const resource = await resources.findById(tx, id, organizationId);
    if (!resource) return null;

    assertMayModify(resource);

    await planLimits.lockForUpdate(tx, organizationId);
    await resources.remove(tx, id, organizationId);
    await planLimits.adjustUsedStorageBytes(tx, organizationId, -resource.sizeBytes);
    return resource;
  });

  if (!removed) {
    await reportIfCrossTenantAttempt(id);
    throw new NotFoundException();
  }

  await publishEvent(organizationId, EVENT_TYPES.RESOURCE_DELETED, {
    resourceId: removed.id,
    sizeDelta: removed.sizeBytes,
  });
}

/**
 * Exists only to be tested: the WHERE-less raw query, scoped by nothing but the
 * transaction's RLS setting. Not exposed over HTTP.
 */
export async function findAllResourcesForReport(): Promise<Resource[]> {
  const rows = await transaction((tx) => resources.findAllResourcesForReport(tx));
  return rows.map(resources.rawToResource);
}

/**
 * Runs only after a scoped read found nothing. Uses the resource_exists() SECURITY
 * DEFINER function (a plain unscoped query sees no rows under FORCE RLS). The event
 * carries the ACTOR's org, never the owner's. Best-effort: it never rethrows, so the
 * caller's 404 cannot depend on it.
 */
async function reportIfCrossTenantAttempt(resourceId: string): Promise<void> {
  try {
    const ctx = contextStore.getOrThrow();

    const existsElsewhere = await runGlobal(async (tx) => {
      const rows = await tx.$queryRaw<
        { resource_exists: boolean }[]
      >`SELECT resource_exists(${resourceId}::uuid)`;
      return rows[0]?.resource_exists ?? false;
    });
    if (!existsElsewhere) return;

    await publish(TOPICS.SECURITY, {
      eventType: EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      payload: {
        subjectType: 'Resource',
        subjectId: resourceId,
        actorOrganizationId: ctx.organizationId,
        actorUserId: ctx.userId,
      },
    });
  } catch (err) {
    logger.error(
      `Cross-tenant detection probe failed for resource ${resourceId}: ${(err as Error).message}`,
    );
  }
}

/** Org admins may modify any resource in their org; members only their own. */
function assertMayModify(resource: Resource): void {
  const ctx = contextStore.getOrThrow();
  if (ctx.roles.includes(Role.ORG_ADMIN)) return;
  if (resource.createdBy === ctx.userId) return;
  throw new ForbiddenException('You may only modify resources you created');
}

async function publishEvent<T>(
  organizationId: string,
  eventType: EventType,
  payload: T,
): Promise<void> {
  await publish(TOPICS.RESOURCE, {
    eventType,
    organizationId,
    actorUserId: contextStore.get()?.userId ?? null,
    payload,
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
