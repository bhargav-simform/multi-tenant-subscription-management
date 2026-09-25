import { contextStore } from '../../src/lib/context-store';
import { NotFoundException } from '../../src/lib/http-errors';
import type { StorageSnapshot } from '../../src/models/plan-limit-cache.model';
import type { Resource } from '../../src/models/resource.model';
import { Role } from '../../src/types/constants';
import { EVENT_TYPES, TOPICS } from '../../src/types/events';

/** The raw tx the resource_exists() probe runs on; its result is set per test. */
const probeTx = { $queryRaw: jest.fn() };

jest.mock('../../src/lib/tenant-db', () => ({
  transaction: jest.fn(async (work: (tx: unknown) => unknown) => work({})),
  transactionForOrganization: jest.fn(async (_orgId: string, work: (tx: unknown) => unknown) =>
    work({}),
  ),
  runGlobal: jest.fn(async (work: (tx: unknown) => unknown) => work(probeTx)),
}));
jest.mock('../../src/lib/events', () => ({ publish: jest.fn(async () => undefined) }));
jest.mock('../../src/models/resource.model', () => ({
  ...jest.requireActual('../../src/models/resource.model'),
  create: jest.fn(),
  findById: jest.fn(),
  listPage: jest.fn(),
  sumSizeBytesForOrg: jest.fn(),
  remove: jest.fn(),
  findAllResourcesForReport: jest.fn(),
}));
jest.mock('../../src/models/plan-limit-cache.model');

import * as events from '../../src/lib/events';
import * as tenantDb from '../../src/lib/tenant-db';
import * as planLimitModel from '../../src/models/plan-limit-cache.model';
import * as resourceModel from '../../src/models/resource.model';
import * as service from '../../src/services/resources.service';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const RESOURCE_ID = '33333333-3333-3333-3333-333333333333';

const mocked = {
  publish: jest.mocked(events.publish),
  transaction: jest.mocked(tenantDb.transaction),
  runGlobal: jest.mocked(tenantDb.runGlobal),
  create: jest.mocked(resourceModel.create),
  findById: jest.mocked(resourceModel.findById),
  sumSizeBytesForOrg: jest.mocked(resourceModel.sumSizeBytesForOrg),
  remove: jest.mocked(resourceModel.remove),
  findAllResourcesForReport: jest.mocked(resourceModel.findAllResourcesForReport),
  lockForUpdate: jest.mocked(planLimitModel.lockForUpdate),
  adjustUsedStorageBytes: jest.mocked(planLimitModel.adjustUsedStorageBytes),
};

/**
 * The storage-limit transaction's SHAPE (lock first, check the counter read under
 * the lock, write and increment together, publish after) and the cross-tenant
 * detection behaviour. These fakes serialise everything, so they cannot prove the
 * FOR UPDATE lock itself — only a real Postgres row can.
 */
describe('resources.service', () => {
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
    };
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

  function setup(
    deps: { storage?: StorageSnapshot; existing?: Resource | null; existsElsewhere?: boolean } = {},
  ) {
    jest.clearAllMocks();
    probeTx.$queryRaw.mockResolvedValue([{ resource_exists: deps.existsElsewhere ?? false }]);
    mocked.lockForUpdate.mockResolvedValue(
      deps.storage ?? { usedStorageBytes: 0, maxStorageBytes: 10_000 },
    );
    mocked.adjustUsedStorageBytes.mockResolvedValue(undefined);
    mocked.create.mockImplementation(async (_tx, data) =>
      makeResource({ name: data.name, sizeBytes: data.sizeBytes }),
    );
    mocked.findById.mockResolvedValue(deps.existing ?? null);
    mocked.remove.mockResolvedValue(undefined);
    mocked.findAllResourcesForReport.mockResolvedValue([]);
  }

  const asMember = <T>(fn: () => Promise<T>, roles?: Role[]) =>
    contextStore.run(buildContext(roles), fn);

  describe('create', () => {
    it('creates the resource, increments the counter by its size, and publishes ResourceCreated after commit', async () => {
      setup({ storage: { usedStorageBytes: 2_000, maxStorageBytes: 10_000 } });

      const result = await asMember(() => service.create({ name: 'report.pdf', sizeBytes: 3_000 }));

      expect(result.sizeBytes).toBe(3_000);
      expect(mocked.lockForUpdate).toHaveBeenCalledWith(expect.anything(), ORG_ID);
      expect(mocked.create).toHaveBeenCalledWith(expect.anything(), {
        organizationId: ORG_ID,
        name: 'report.pdf',
        description: null,
        sizeBytes: 3_000,
        createdBy: USER_ID,
      });
      expect(mocked.adjustUsedStorageBytes).toHaveBeenCalledWith(expect.anything(), ORG_ID, 3_000);
      expect(mocked.publish).toHaveBeenCalledWith(
        TOPICS.RESOURCE,
        expect.objectContaining({
          eventType: EVENT_TYPES.RESOURCE_CREATED,
          organizationId: ORG_ID,
          // storage-reconciliation reads exactly this field.
          payload: expect.objectContaining({ sizeDelta: 3_000 }),
        }),
      );
    });

    it('rejects with a specific, actionable 409 when the resource would exceed the ceiling, writing nothing', async () => {
      setup({ storage: { usedStorageBytes: 9_000, maxStorageBytes: 10_000 } });

      const err = await asMember(() => service.create({ name: 'big.bin', sizeBytes: 2_000 })).catch(
        (e: unknown) => e,
      );

      expect((err as { getBody(): unknown }).getBody()).toEqual({
        statusCode: 409,
        error: 'PLAN_LIMIT_EXCEEDED',
        details: { limitType: 'storage', limit: 10_000, current: 9_000, planCode: 'unknown' },
        message:
          'This resource needs 2.0 KB, but only 1000 B of your 9.8 KB storage limit remains (8.8 KB in use). ' +
          'Delete an existing resource or upgrade your plan to add more.',
      });
      expect(mocked.create).not.toHaveBeenCalled();
      expect(mocked.adjustUsedStorageBytes).not.toHaveBeenCalled();
      expect(mocked.publish).not.toHaveBeenCalled();
    });

    it('allows a resource that exactly fills the remaining space (boundary: projected == limit)', async () => {
      setup({ storage: { usedStorageBytes: 9_000, maxStorageBytes: 10_000 } });

      await expect(
        asMember(() => service.create({ name: 'exact.bin', sizeBytes: 1_000 })),
      ).resolves.toBeDefined();
      expect(mocked.adjustUsedStorageBytes).toHaveBeenCalledWith(expect.anything(), ORG_ID, 1_000);
    });

    it('never recomputes the total with SUM on the hot path — the locked counter is authoritative', async () => {
      setup({ storage: { usedStorageBytes: 2_000, maxStorageBytes: 10_000 } });

      await asMember(() => service.create({ name: 'report.pdf', sizeBytes: 1_000 }));

      expect(mocked.sumSizeBytesForOrg).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('returns the resource when RLS lets it through', async () => {
      setup({ existing: makeResource() });

      const result = await asMember(() => service.getById(RESOURCE_ID));

      expect(result.id).toBe(RESOURCE_ID);
      expect(mocked.findById).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID, ORG_ID);
      expect(mocked.publish).not.toHaveBeenCalled();
    });

    it('404s AND publishes CrossTenantAccessAttempted when the id exists in another org', async () => {
      setup({ existing: null, existsElsewhere: true });

      await expect(asMember(() => service.getById(RESOURCE_ID))).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(mocked.runGlobal).toHaveBeenCalled();
      expect(mocked.publish).toHaveBeenCalledWith(TOPICS.SECURITY, {
        eventType: EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED,
        organizationId: ORG_ID,
        actorUserId: USER_ID,
        payload: {
          subjectType: 'Resource',
          subjectId: RESOURCE_ID,
          actorOrganizationId: ORG_ID,
          actorUserId: USER_ID,
        },
      });
    });

    it('404s with NO security event when the id genuinely does not exist anywhere', async () => {
      setup({ existing: null, existsElsewhere: false });

      await expect(asMember(() => service.getById(RESOURCE_ID))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocked.publish).not.toHaveBeenCalled();
    });

    it('still 404s when the detection probe itself fails', async () => {
      setup({ existing: null });
      probeTx.$queryRaw.mockRejectedValue(new Error('pool exhausted'));

      await expect(asMember(() => service.getById(RESOURCE_ID))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the SAME 404 for a cross-tenant id as for a missing one (no existence oracle)', async () => {
      setup({ existing: null, existsElsewhere: true });
      const foreignErr = (await asMember(() => service.getById(RESOURCE_ID)).catch(
        (e: unknown) => e,
      )) as NotFoundException;
      setup({ existing: null, existsElsewhere: false });
      const missingErr = (await asMember(() => service.getById(RESOURCE_ID)).catch(
        (e: unknown) => e,
      )) as NotFoundException;

      expect(foreignErr.status).toBe(404);
      expect(missingErr.status).toBe(404);
      expect(foreignErr.getBody()).toEqual(missingErr.getBody());
      expect(foreignErr.getBody()).toEqual({ message: 'Not Found', statusCode: 404 });
    });
  });

  describe('remove', () => {
    it('locks first, soft-deletes, decrements by the resource size, and publishes after commit', async () => {
      setup({ existing: makeResource({ sizeBytes: 2_500 }) });

      await asMember(() => service.remove(RESOURCE_ID));

      expect(mocked.lockForUpdate).toHaveBeenCalledWith(expect.anything(), ORG_ID);
      expect(mocked.remove).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID, ORG_ID);
      expect(mocked.adjustUsedStorageBytes).toHaveBeenCalledWith(expect.anything(), ORG_ID, -2_500);
      expect(mocked.publish).toHaveBeenCalledWith(
        TOPICS.RESOURCE,
        expect.objectContaining({
          eventType: EVENT_TYPES.RESOURCE_DELETED,
          payload: { resourceId: RESOURCE_ID, sizeDelta: 2_500 },
        }),
      );
    });

    it('404s (never 403) when the RLS-scoped read finds nothing', async () => {
      setup({ existing: null, existsElsewhere: false });

      await expect(asMember(() => service.remove(RESOURCE_ID))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocked.adjustUsedStorageBytes).not.toHaveBeenCalled();
    });

    it("403s when a member targets another member's resource in their OWN org", async () => {
      setup({ existing: makeResource({ createdBy: 'someone-else' }) });

      const err = await asMember(() => service.remove(RESOURCE_ID), [Role.ORG_MEMBER]).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ status: 403 });
      expect((err as { getBody(): unknown }).getBody()).toEqual({
        message: 'You may only modify resources you created',
        error: 'Forbidden',
        statusCode: 403,
      });
      expect(mocked.remove).not.toHaveBeenCalled();
      expect(mocked.lockForUpdate).not.toHaveBeenCalled();
    });

    it('lets an org admin delete a resource created by someone else', async () => {
      setup({ existing: makeResource({ createdBy: 'someone-else' }) });

      await asMember(() => service.remove(RESOURCE_ID), [Role.ORG_ADMIN]);

      expect(mocked.remove).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID, ORG_ID);
    });
  });

  describe('findAllResourcesForReport', () => {
    it('applies no tenant filter of its own — it runs the careless query in a SCOPED transaction', async () => {
      setup();

      await asMember(() => service.findAllResourcesForReport());

      expect(mocked.transaction).toHaveBeenCalled();
      expect(mocked.runGlobal).not.toHaveBeenCalled();
      expect(mocked.findAllResourcesForReport).toHaveBeenCalledWith(expect.anything());
    });
  });
});
