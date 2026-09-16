import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { EventPublisher, type DomainEvent } from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS, PlanLimitExceededException, Role } from '@app/common';
import type { CursorPage, CursorQuery } from '@app/common';
import { Resource } from './resource.entity';
import {
  RESOURCE_REPOSITORY,
  type IResourceRepository,
  type RawResourceRow,
} from './resource.repository.interface';
import {
  PLAN_LIMIT_CACHE_REPOSITORY,
  type IPlanLimitCacheRepository,
} from './plan-limit-cache.repository.interface';
import type { CreateResourceDto } from './dto/create-resource.dto';
import type { ResourceResponseDto } from './dto/resource-response.dto';

/**
 * §8.6, §19.6: owns the storage-limit transaction. Every method that changes
 * used_storage_bytes locks the plan_limit_cache row FIRST (§19.7 — consistent
 * lock ordering), inside ONE transaction with its own write, and publishes
 * events only AFTER commit (§17.5). No network call ever happens inside a
 * transaction here.
 */
@Injectable()
export class ResourcesService {
  private readonly logger = new Logger(ResourcesService.name);

  constructor(
    private readonly tenantDataSource: TenantAwareDataSource,
    private readonly tenantContext: TenantContextStore,
    private readonly publisher: EventPublisher,
    @Inject(RESOURCE_REPOSITORY) private readonly resources: IResourceRepository,
    @Inject(PLAN_LIMIT_CACHE_REPOSITORY)
    private readonly planLimits: IPlanLimitCacheRepository,
  ) {}

  /**
   * §19.6 — the storage-limit path, structurally identical to §19.2's seat
   * path: lock, check the authoritative counter read under that lock, write
   * and increment in the SAME transaction, publish after commit.
   *
   * The counter (`plan_limit_cache.used_storage_bytes`) is read under the
   * lock and is NOT recomputed with SUM(resources.size_bytes) — §19.4's rule.
   * The enforced quantity and the quantity the CHECK constraint guards are
   * one column, not two; if enforcement summed the rows while the CHECK
   * constrained the counter, a path that inserted a resource without
   * incrementing would breach the real limit with the constraint still
   * satisfied.
   */
  async create(dto: CreateResourceDto): Promise<ResourceResponseDto> {
    const ctx = this.tenantContext.getOrThrow();
    const organizationId = ctx.organizationId!;
    const createdBy = ctx.userId!;

    const resource = await this.tenantDataSource.transaction(async (manager) => {
      // 1. Lock the plan_limit_cache row FIRST — always the first lock taken.
      //    A concurrent create BLOCKS here and re-reads only after this
      //    transaction commits (§19.3), which is the entire R7 guarantee.
      const storage = await this.planLimits.lockForUpdate(organizationId, manager);

      // 2. Check the authoritative counter, read under that lock.
      const projected = storage.usedStorageBytes + dto.sizeBytes;
      if (projected > storage.maxStorageBytes) {
        const remaining = Math.max(0, storage.maxStorageBytes - storage.usedStorageBytes);
        // §19.5/R6: specific and actionable — names the actual numbers and
        // what to do, never a generic error. Rollback is automatic: this
        // propagates out of transaction(), so no resource row and no
        // incremented counter survive.
        throw new PlanLimitExceededException(
          {
            limitType: 'storage',
            limit: storage.maxStorageBytes,
            current: storage.usedStorageBytes,
            // subscription-service owns plan metadata; plan_limit_cache
            // stores only the ceiling, not which plan produced it, so the
            // code is genuinely not available here — matching how
            // user-service reports 'unknown' for the same reason.
            planCode: 'unknown',
          },
          `This resource needs ${formatBytes(dto.sizeBytes)}, but only ` +
            `${formatBytes(remaining)} of your ${formatBytes(storage.maxStorageBytes)} storage ` +
            `limit remains (${formatBytes(storage.usedStorageBytes)} in use). ` +
            `Delete an existing resource or upgrade your plan to add more.`,
        );
      }

      // 3. Write and increment the counter in the SAME transaction. The
      //    ck_plan_limit_storage CHECK constraint backstops the increment
      //    (§19.4): even a future code path that skipped the lock above
      //    could not drive used_storage_bytes past the ceiling.
      const created = await this.resources.create(
        {
          name: dto.name,
          description: dto.description ?? null,
          sizeBytes: dto.sizeBytes,
          createdBy,
        },
        manager,
      );
      await this.planLimits.adjustUsedStorageBytes(organizationId, dto.sizeBytes, manager);
      return created;
    });

    // 4. Publish AFTER commit (§17.5) — never inside the transaction. The
    //    `sizeDelta` field is what subscription-service's
    //    StorageReconciliationConsumer reads to maintain its own DISPLAY
    //    copy of used_storage_bytes (§8.5); that copy is not an enforcement
    //    path, this service's locked counter is.
    await this.publishEvent(organizationId, EVENT_TYPES.RESOURCE_CREATED, {
      resourceId: resource.id,
      name: resource.name,
      sizeDelta: resource.sizeBytes,
    });

    return toDto(resource);
  }

  /**
   * §13, H1 — THE SHARPEST TEST TARGET IN THE SYSTEM (§8.6). A user of Org A
   * asking for an Org B resource by id must get a 404 that is
   * indistinguishable from "no such resource", while the attempt is still
   * detected internally (§13.9, layer 4).
   *
   * The read itself is RLS-scoped, so a foreign row simply is not there. When
   * nothing is found, a NARROW existence-only probe runs through runGlobal()
   * to decide whether this was a cross-tenant attempt or a genuine miss:
   *   - It selects `1` and nothing else — no columns, and crucially NOT
   *     organization_id, so the owning tenant is never even loaded into this
   *     process's memory, let alone returned.
   *   - Its ONLY output is a boolean that decides whether to emit a security
   *     event. It never reaches the caller.
   *   - The caller gets exactly the same 404 either way. Never a 403: a 403
   *     would confirm the resource exists, which is the existence oracle
   *     isolation exists to prevent (§13.9).
   *
   * runGlobal() is used deliberately and is an audited exception (§13.6): it
   * grants no special privilege — the query still runs as app_user — it
   * simply leaves app.current_org unset so RLS does not filter this one
   * existence check. `resources` is FORCE-protected, so without runGlobal the
   * probe would return nothing and every cross-tenant attempt would look
   * identical to a genuine miss, leaving layer 4 blind.
   *
   * The probe is best-effort (§32.4): a failure in the DETECTION side-channel
   * must never turn the caller's response into anything other than the same
   * 404 a genuine miss gets — §13.9's no-existence-oracle guarantee cannot
   * depend on the probe succeeding. See reportIfCrossTenantAttempt.
   */
  async getById(id: string): Promise<ResourceResponseDto> {
    const resource = await this.tenantDataSource.transaction((manager) =>
      this.resources.findById(id, manager),
    );

    if (!resource) {
      await this.reportIfCrossTenantAttempt(id);
      throw new NotFoundException();
    }

    return toDto(resource);
  }

  /** §29: thin wrapper — keyset pagination, RLS-scoped via a transaction. */
  async listPage(query: CursorQuery): Promise<CursorPage<ResourceResponseDto>> {
    const page = await this.tenantDataSource.transaction((manager) =>
      this.resources.listPage(query, manager),
    );
    return { ...page, items: page.items.map(toDto) };
  }

  /**
   * §19.6 in reverse: frees storage. Takes the SAME lock-first-then-write
   * ordering as create(), so a delete racing a create serialises on the same
   * row rather than interleaving.
   *
   * 404 (never 403) when the RLS-scoped read finds nothing, for the same
   * no-existence-oracle reason as getById — including the cross-tenant
   * detection probe.
   *
   * AUTHORIZATION NOTE: @CheckAbility on the controller checks the SUBJECT
   * TYPE only ("may this role ever delete a Resource") — see
   * check-ability.decorator.ts. CASL's ORG_MEMBER rule is conditional on
   * `createdBy === ctx.userId` (§12.3), and a condition can only be evaluated
   * against a LOADED row, which only this layer has. So the ownership half of
   * that rule is enforced here, inside the transaction, after the read.
   */
  async remove(id: string): Promise<void> {
    const ctx = this.tenantContext.getOrThrow();
    const organizationId = ctx.organizationId!;

    const removed = await this.tenantDataSource.transaction(async (manager) => {
      const resource = await this.resources.findById(id, manager);
      if (!resource) return null;

      this.assertMayModify(resource);

      // Lock FIRST, then write — the same ordering create() uses.
      await this.planLimits.lockForUpdate(organizationId, manager);
      await this.resources.remove(id, manager);
      await this.planLimits.adjustUsedStorageBytes(organizationId, -resource.sizeBytes, manager);
      return resource;
    });

    if (!removed) {
      await this.reportIfCrossTenantAttempt(id);
      throw new NotFoundException();
    }

    await this.publishEvent(organizationId, EVENT_TYPES.RESOURCE_DELETED, {
      resourceId: removed.id,
      sizeDelta: removed.sizeBytes,
    });
  }

  /**
   * §13.1 — exists ONLY to be tested, and proves this architecture's central
   * claim. It calls the repository's deliberately-careless, WHERE-less raw
   * query and returns whatever RLS lets through. There is NO tenant filter
   * here or beneath it, by design; the scoped transaction is the only thing
   * that scopes it, and that is exactly the property under test.
   *
   * Not exposed on the HTTP controller — it is a proof, not a feature.
   */
  async findAllResourcesForReport(): Promise<ResourceResponseDto[]> {
    const rows = await this.tenantDataSource.transaction((manager) =>
      this.resources.findAllResourcesForReport(manager),
    );
    return rows.map(rawToDto);
  }

  /**
   * §13.9, layer 4. Runs ONLY after an RLS-scoped read already returned
   * nothing. Publishes CrossTenantAccessAttempted when the id exists under
   * some other organisation — with the attempted resource id and the ACTOR's
   * own org/user id, and deliberately NOT the owning organisation's id, which
   * this method never learns. audit-service correlates the owning side from
   * its own records (§13.9); a security event is not a place to leak the
   * answer the 404 withheld.
   *
   * §32.4: wrapped in try/catch and never rethrows. This is a best-effort
   * DETECTION side-channel, not the data path — the RLS-policy fix (see
   * enableTenantRls's doc comment) means the probe should not normally throw,
   * but this method must not become a second way for the H1 endpoint to
   * return anything other than 404 if it ever does (a stuck connection pool,
   * a future regression in the policy, anything). A missed security event is
   * a detection gap worth logging loudly; it must never be a correctness gap
   * in the response the caller sees.
   */
  private async reportIfCrossTenantAttempt(resourceId: string): Promise<void> {
    try {
      const ctx = this.tenantContext.getOrThrow();

      // §13.6, §32.4: NOT a plain unscoped query, even via runGlobal() — see
      // the "resource_exists" SECURITY DEFINER function's doc comment in the
      // migration for why an ordinary query can never see ANY row here
      // (FORCE ROW LEVEL SECURITY makes `organization_id = NULL` unknown for
      // every row alike, not just a foreign one), and why this function is
      // the correct narrow exception instead.
      const existsElsewhere = await this.tenantDataSource.runGlobal(async (manager) => {
        const rows = await manager.query<{ resource_exists: boolean }[]>(
          'SELECT resource_exists($1)',
          [resourceId],
        );
        return rows[0]?.resource_exists ?? false;
      });

      if (!existsElsewhere) return;

      await this.publisher.publish(KAFKA_TOPICS.SECURITY, {
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
      this.logger.error(
        `Cross-tenant detection probe failed for resource ${resourceId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * §12.3's conditional half, enforced where the row is available. An org
   * admin may MANAGE any resource in their organisation; a member may modify
   * only their own. This is authorization ("what may you do?"), not tenant
   * isolation — the row reaching this point at all is already guaranteed by
   * RLS to belong to the caller's organisation, so 403 is the honest status
   * here (unlike a cross-tenant id, which must be 404).
   */
  private assertMayModify(resource: Resource): void {
    const ctx = this.tenantContext.getOrThrow();
    if (ctx.roles.includes(Role.ORG_ADMIN)) return;
    if (resource.createdBy === ctx.userId) return;
    throw new ForbiddenException('You may only modify resources you created');
  }

  private async publishEvent<T>(
    organizationId: string,
    eventType: (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES],
    payload: T,
  ): Promise<void> {
    const event: DomainEvent<T> = {
      eventType,
      organizationId,
      actorUserId: this.tenantContext.get()?.userId ?? null,
      payload,
    };
    await this.publisher.publish(KAFKA_TOPICS.RESOURCE, event);
  }
}

function toDto(resource: Resource): ResourceResponseDto {
  return {
    id: resource.id,
    name: resource.name,
    description: resource.description,
    sizeBytes: resource.sizeBytes,
    createdBy: resource.createdBy,
    createdAt: resource.createdAt,
  };
}

/**
 * Maps a RAW row (snake_case, bigint-as-string) from the §13.1 careless query
 * — which bypasses TypeORM's mapping entirely, so neither the column naming
 * strategy nor bigintTransformer has applied to it.
 */
function rawToDto(row: RawResourceRow): ResourceResponseDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sizeBytes: Number(row.size_bytes),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
