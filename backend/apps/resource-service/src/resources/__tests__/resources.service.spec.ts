import { jest, describe, it, expect } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { EventPublisher } from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS, Role } from '@app/common';
import { ResourcesService } from '../resources.service';
import { RESOURCE_REPOSITORY } from '../resource.repository.interface';
import { PLAN_LIMIT_CACHE_REPOSITORY } from '../plan-limit-cache.repository.interface';
import type { StorageSnapshot } from '../plan-limit-cache.repository.interface';
import type { Resource } from '../resource.entity';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const RESOURCE_ID = '33333333-3333-3333-3333-333333333333';

/**
 * §19.6: the storage-limit transaction. These tests prove the transaction's
 * SHAPE — lock first, check the counter read under that lock, write and
 * increment together, publish only after — and the §13.9 cross-tenant
 * detection behaviour.
 *
 * WHAT THESE TESTS CANNOT PROVE, stated plainly so nobody mistakes a green
 * run here for the real guarantee: the fake data source below serialises
 * every caller unconditionally, so it would pass just as happily if
 * `.setLock('pessimistic_write')` were deleted from the repository. Only the
 * Testcontainers suite (test/integration/resource-service/) exercises a real
 * `SELECT ... FOR UPDATE` against a real PostgreSQL row and can detect a
 * missing lock. Both suites are required; neither substitutes for the other.
 */
describe('ResourcesService', () => {
  function makeResource(overrides: Partial<Resource> = {}): Resource {
    return {
      id: RESOURCE_ID,
      organizationId: ORG_ID,
      name: 'report.pdf',
      description: null,
      sizeBytes: 1_000,
      createdBy: USER_ID,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
      deletedAt: null,
      ...overrides,
    } as Resource;
  }

  function buildContext(roles: Role[] = [Role.ORG_MEMBER]) {
    return {
      userId: USER_ID,
      organizationId: ORG_ID,
      roles,
      correlationId: 'corr-1',
      iat: 0,
      exp: 0,
    };
  }

  async function buildService(deps: {
    storage?: StorageSnapshot;
    existing?: Resource | null;
    /** What the narrow runGlobal() existence probe reports (§13.9). */
    existsElsewhere?: boolean;
  }) {
    const tenantContext = new TenantContextStore();
    const storage: StorageSnapshot = deps.storage ?? {
      usedStorageBytes: 0,
      maxStorageBytes: 10_000,
    };

    const dataSource = {
      transaction: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) => work({})),
      transactionForOrganization: jest
        .fn<(organizationId: string, work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (_organizationId, work) => work({})),
      // The narrow §13.9 existence probe runs through this, calling the
      // resource_exists(uuid) SECURITY DEFINER function (§13.6, §32.4) —
      // never a plain unscoped SELECT, which could never see any row under
      // FORCE ROW LEVEL SECURITY regardless of org.
      runGlobal: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) =>
          work({
            query: jest
              .fn<() => Promise<unknown[]>>()
              .mockResolvedValue([{ resource_exists: deps.existsElsewhere ?? false }]),
          }),
        ),
    };

    const resources = {
      create: jest
        .fn<(data: { name: string; sizeBytes: number }, m: unknown) => Promise<Resource>>()
        .mockImplementation(async (data) =>
          makeResource({ name: data.name, sizeBytes: data.sizeBytes }),
        ),
      findById: jest
        .fn<(id: string, m: unknown) => Promise<Resource | null>>()
        .mockResolvedValue(deps.existing ?? null),
      listPage: jest.fn<(q: unknown, m: unknown) => Promise<unknown>>().mockResolvedValue({
        items: [makeResource()],
        hasMore: false,
        nextCursor: null,
      }),
      sumSizeBytesForOrg: jest
        .fn<(orgId: string, m: unknown) => Promise<number>>()
        .mockResolvedValue(0),
      remove: jest.fn<(id: string, m: unknown) => Promise<void>>().mockResolvedValue(undefined),
      findAllResourcesForReport: jest
        .fn<(m: unknown) => Promise<unknown[]>>()
        .mockResolvedValue([]),
    };

    const planLimits = {
      lockForUpdate: jest
        .fn<(orgId: string, m: unknown) => Promise<StorageSnapshot>>()
        .mockResolvedValue(storage),
      findByOrganizationId: jest
        .fn<(orgId: string, m: unknown) => Promise<unknown>>()
        .mockResolvedValue(null),
      upsert: jest
        .fn<(orgId: string, max: number, m: unknown) => Promise<void>>()
        .mockResolvedValue(undefined),
      adjustUsedStorageBytes: jest
        .fn<(orgId: string, delta: number, m: unknown) => Promise<void>>()
        .mockResolvedValue(undefined),
    };

    const publisher = {
      publish: jest
        .fn<(topic: string, event: unknown) => Promise<void>>()
        .mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ResourcesService,
        { provide: TenantAwareDataSource, useValue: dataSource },
        { provide: TenantContextStore, useValue: tenantContext },
        { provide: EventPublisher, useValue: publisher },
        { provide: RESOURCE_REPOSITORY, useValue: resources },
        { provide: PLAN_LIMIT_CACHE_REPOSITORY, useValue: planLimits },
      ],
    }).compile();

    return {
      service: moduleRef.get(ResourcesService),
      tenantContext,
      resources,
      planLimits,
      publisher,
      dataSource,
    };
  }

  describe('create (§19.6)', () => {
    it('creates the resource, increments the counter by its size, and publishes ResourceCreated after commit', async () => {
      const { service, tenantContext, resources, planLimits, publisher } = await buildService({
        storage: { usedStorageBytes: 2_000, maxStorageBytes: 10_000 },
      });

      const result = await tenantContext.run(buildContext(), () =>
        service.create({ name: 'report.pdf', sizeBytes: 3_000 }),
      );

      expect(result.sizeBytes).toBe(3_000);
      expect(planLimits.lockForUpdate).toHaveBeenCalledWith(ORG_ID, expect.anything());
      expect(resources.create).toHaveBeenCalled();
      // The counter moves by exactly the new resource's size, in the same txn.
      expect(planLimits.adjustUsedStorageBytes).toHaveBeenCalledWith(
        ORG_ID,
        3_000,
        expect.anything(),
      );
      expect(publisher.publish).toHaveBeenCalledWith(
        KAFKA_TOPICS.RESOURCE,
        expect.objectContaining({
          eventType: EVENT_TYPES.RESOURCE_CREATED,
          organizationId: ORG_ID,
          // subscription-service's StorageReconciliationConsumer reads
          // exactly this field (§8.5) — renaming it silently breaks that
          // service's display counter.
          payload: expect.objectContaining({ sizeDelta: 3_000 }),
        }),
      );
    });

    it('rejects with a specific, actionable 409 when the resource would exceed the ceiling, writing nothing', async () => {
      const { service, tenantContext, resources, planLimits, publisher } = await buildService({
        storage: { usedStorageBytes: 9_000, maxStorageBytes: 10_000 },
      });

      await expect(
        tenantContext.run(buildContext(), () =>
          service.create({ name: 'big.bin', sizeBytes: 2_000 }),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          error: 'PLAN_LIMIT_EXCEEDED',
          details: expect.objectContaining({
            limitType: 'storage',
            limit: 10_000,
            current: 9_000,
          }),
        }),
      });

      // §19.5: no partial state — no resource row, no counter increment, and
      // no event (the publish is after commit, and there was no commit).
      expect(resources.create).not.toHaveBeenCalled();
      expect(planLimits.adjustUsedStorageBytes).not.toHaveBeenCalled();
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('names the actual remaining space and what to do about it (R6: never a generic error)', async () => {
      const { service, tenantContext } = await buildService({
        storage: { usedStorageBytes: 9_000, maxStorageBytes: 10_000 },
      });

      await expect(
        tenantContext.run(buildContext(), () =>
          service.create({ name: 'big.bin', sizeBytes: 2_000 }),
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          message: expect.stringMatching(/Delete an existing resource or upgrade your plan/),
        }),
      });
    });

    it('allows a resource that exactly fills the remaining space (boundary: projected == limit)', async () => {
      const { service, tenantContext, planLimits } = await buildService({
        storage: { usedStorageBytes: 9_000, maxStorageBytes: 10_000 },
      });

      await expect(
        tenantContext.run(buildContext(), () =>
          service.create({ name: 'exact.bin', sizeBytes: 1_000 }),
        ),
      ).resolves.toBeDefined();

      expect(planLimits.adjustUsedStorageBytes).toHaveBeenCalledWith(
        ORG_ID,
        1_000,
        expect.anything(),
      );
    });

    it('never recomputes the total with SUM on the hot path — the locked counter is authoritative (§19.4)', async () => {
      const { service, tenantContext, resources } = await buildService({
        storage: { usedStorageBytes: 2_000, maxStorageBytes: 10_000 },
      });

      await tenantContext.run(buildContext(), () =>
        service.create({ name: 'report.pdf', sizeBytes: 1_000 }),
      );

      expect(resources.sumSizeBytesForOrg).not.toHaveBeenCalled();
    });
  });

  describe('getById (§13, H1)', () => {
    it('returns the resource when RLS lets it through', async () => {
      const { service, tenantContext, publisher } = await buildService({
        existing: makeResource(),
      });

      const result = await tenantContext.run(buildContext(), () => service.getById(RESOURCE_ID));

      expect(result.id).toBe(RESOURCE_ID);
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('404s AND publishes CrossTenantAccessAttempted when the id exists in another org', async () => {
      const { service, tenantContext, publisher, dataSource } = await buildService({
        existing: null,
        existsElsewhere: true,
      });

      await expect(
        tenantContext.run(buildContext(), () => service.getById(RESOURCE_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);

      // The narrow existence probe ran through runGlobal (§13.6's audited
      // exception), not through the ordinary scoped path.
      expect(dataSource.runGlobal).toHaveBeenCalled();

      expect(publisher.publish).toHaveBeenCalledWith(
        KAFKA_TOPICS.SECURITY,
        expect.objectContaining({
          eventType: EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED,
          payload: expect.objectContaining({
            subjectType: 'Resource',
            subjectId: RESOURCE_ID,
            actorOrganizationId: ORG_ID,
          }),
        }),
      );
    });

    it('never reveals the OWNING organisation in the security event (§13.9)', async () => {
      const { service, tenantContext, publisher } = await buildService({
        existing: null,
        existsElsewhere: true,
      });

      await expect(
        tenantContext.run(buildContext(), () => service.getById(RESOURCE_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);

      const [, event] = publisher.publish.mock.calls[0] as [
        string,
        { payload: Record<string, unknown>; organizationId: string | null },
      ];
      // Every organisation id anywhere in the event is the ACTOR's own. The
      // owner's is never looked up, so it cannot appear.
      const orgIds = Object.entries(event.payload)
        .filter(([key]) => key.toLowerCase().includes('organization'))
        .map(([, value]) => value);
      expect(orgIds.every((id) => id === ORG_ID)).toBe(true);
      expect(event.organizationId).toBe(ORG_ID);
    });

    it('404s with NO security event when the id genuinely does not exist anywhere', async () => {
      const { service, tenantContext, publisher } = await buildService({
        existing: null,
        existsElsewhere: false,
      });

      await expect(
        tenantContext.run(buildContext(), () => service.getById(RESOURCE_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('returns the SAME 404 for a cross-tenant id as for a missing one (no existence oracle)', async () => {
      const foreign = await buildService({ existing: null, existsElsewhere: true });
      const missing = await buildService({ existing: null, existsElsewhere: false });

      async function captureError(run: () => Promise<unknown>): Promise<NotFoundException> {
        try {
          await run();
        } catch (err) {
          return err as NotFoundException;
        }
        throw new Error('expected getById to reject, but it resolved');
      }

      const foreignErr = await captureError(() =>
        foreign.tenantContext.run(buildContext(), () => foreign.service.getById(RESOURCE_ID)),
      );
      const missingErr = await captureError(() =>
        missing.tenantContext.run(buildContext(), () => missing.service.getById(RESOURCE_ID)),
      );

      // §13.9: identical status AND identical body. A 403, or any differing
      // message, would confirm the resource exists.
      expect(foreignErr.getStatus()).toBe(404);
      expect(missingErr.getStatus()).toBe(404);
      expect(foreignErr.getResponse()).toEqual(missingErr.getResponse());
    });
  });

  describe('remove (§19.6 in reverse)', () => {
    it('locks first, soft-deletes, decrements by the resource size, and publishes after commit', async () => {
      const { service, tenantContext, resources, planLimits, publisher } = await buildService({
        existing: makeResource({ sizeBytes: 2_500 }),
      });

      await tenantContext.run(buildContext(), () => service.remove(RESOURCE_ID));

      expect(planLimits.lockForUpdate).toHaveBeenCalledWith(ORG_ID, expect.anything());
      expect(resources.remove).toHaveBeenCalledWith(RESOURCE_ID, expect.anything());
      // Decrement is NEGATIVE and exactly the size that was added.
      expect(planLimits.adjustUsedStorageBytes).toHaveBeenCalledWith(
        ORG_ID,
        -2_500,
        expect.anything(),
      );
      expect(publisher.publish).toHaveBeenCalledWith(
        KAFKA_TOPICS.RESOURCE,
        expect.objectContaining({
          eventType: EVENT_TYPES.RESOURCE_DELETED,
          payload: expect.objectContaining({ sizeDelta: 2_500 }),
        }),
      );
    });

    it('404s (never 403) when the RLS-scoped read finds nothing', async () => {
      const { service, tenantContext, planLimits } = await buildService({
        existing: null,
        existsElsewhere: false,
      });

      await expect(
        tenantContext.run(buildContext(), () => service.remove(RESOURCE_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(planLimits.adjustUsedStorageBytes).not.toHaveBeenCalled();
    });

    it('403s when a member targets another member\'s resource in their OWN org (§12.3 ownership)', async () => {
      const { service, tenantContext, resources } = await buildService({
        existing: makeResource({ createdBy: 'someone-else' }),
      });

      // 403, not 404, is correct HERE and only here: RLS already proved the
      // row belongs to the caller's organisation, so its existence is not
      // secret from them — this is an authorization answer, not isolation.
      await expect(
        tenantContext.run(buildContext([Role.ORG_MEMBER]), () => service.remove(RESOURCE_ID)),
      ).rejects.toMatchObject({ status: 403 });

      expect(resources.remove).not.toHaveBeenCalled();
    });

    it('lets an org admin delete a resource created by someone else (§12.3 MANAGE)', async () => {
      const { service, tenantContext, resources } = await buildService({
        existing: makeResource({ createdBy: 'someone-else' }),
      });

      await tenantContext.run(buildContext([Role.ORG_ADMIN]), () => service.remove(RESOURCE_ID));

      expect(resources.remove).toHaveBeenCalledWith(RESOURCE_ID, expect.anything());
    });
  });

  describe('findAllResourcesForReport (§13.1)', () => {
    it('applies no tenant filter of its own — it returns exactly what the scoped query yields', async () => {
      const { service, tenantContext, resources, dataSource } = await buildService({});

      await tenantContext.run(buildContext(), () => service.findAllResourcesForReport());

      // The proof that matters is the integration test (real RLS). What this
      // asserts is the other half: the method runs inside a SCOPED
      // transaction, which is the only thing that sets app.current_org, and
      // passes no filter of any kind down to the query.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(dataSource.runGlobal).not.toHaveBeenCalled();
      expect(resources.findAllResourcesForReport).toHaveBeenCalledWith(expect.anything());
    });
  });
});
