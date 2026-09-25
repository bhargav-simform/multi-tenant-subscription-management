import { randomUUID } from 'node:crypto';
import { PlanLimitExceededException, ServiceUnavailableException } from '../../src/lib/http-errors';
import { transactionForOrganization } from '../../src/lib/tenant-db';
import * as planLimits from '../../src/models/plan-limit-cache.model';
import * as resourcesService from '../../src/services/resources.service';
import { Role } from '../../src/types/constants';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { deferred, runAs, sleep } from '../support/tenant-fixtures';

const USER_ID = '22222222-2222-2222-2222-222222222222';

/**
 * The REAL storage-limit concurrency proof, counterpart of the seat-lock suite. The
 * unit tests prove the transaction's shape but cannot detect a missing lock (their
 * fakes serialise everything). This drives resources.service.create() — the actual
 * production path — against a real plan_limit_cache row. If lockForUpdate() ever
 * stopped emitting FOR UPDATE, the concurrent-pair and 50-burst tests fail.
 */
describe('resources storage limit — real PostgreSQL row locking', () => {
  const db = new PostgresTestContainer();
  let orgId: string;

  beforeAll(() => db.start());
  afterAll(() => db.stop());

  /** A fresh org per test: no cleanup, and no cross-test interference. */
  async function seed(usedStorageBytes: number, maxStorageBytes: number): Promise<void> {
    orgId = randomUUID();
    await transactionForOrganization(
      orgId,
      (tx) => tx.$executeRaw`
        INSERT INTO plan_limit_cache (organization_id, max_storage_bytes, used_storage_bytes)
        VALUES (${orgId}::uuid, ${maxStorageBytes}::bigint, ${usedStorageBytes}::bigint)`,
    );
  }

  async function readCounter(): Promise<number> {
    const cache = await transactionForOrganization(orgId, (tx) =>
      planLimits.findByOrganizationId(tx, orgId),
    );
    return cache!.usedStorageBytes;
  }

  async function countResources(): Promise<number> {
    return transactionForOrganization(orgId, (tx) =>
      tx.resource.count({ where: { organizationId: orgId, deletedAt: null } }),
    );
  }

  /** The production create path; 'rejected' only for the specific 409. */
  async function attemptCreate(sizeBytes: number): Promise<'created' | 'rejected'> {
    try {
      await runAs(orgId, USER_ID, () => resourcesService.create({ name: 'file', sizeBytes }));
      return 'created';
    } catch (err) {
      if (err instanceof PlanLimitExceededException) return 'rejected';
      throw err;
    }
  }

  it('SELECT ... FOR UPDATE genuinely blocks a concurrent locker until the first commits', async () => {
    await seed(8_000, 10_000);
    const order: string[] = [];
    const aLocked = deferred();
    const releaseA = deferred();

    const txA = transactionForOrganization(orgId, async (tx) => {
      const s = await planLimits.lockForUpdate(tx, orgId);
      order.push('A-locked');
      expect(s.usedStorageBytes).toBe(8_000);
      aLocked.resolve();
      await releaseA.promise;
      await planLimits.adjustUsedStorageBytes(tx, orgId, 2_000);
    });
    await aLocked.promise;

    let bResolved = false;
    const txB = transactionForOrganization(orgId, async (tx) => {
      const s = await planLimits.lockForUpdate(tx, orgId);
      bResolved = true;
      order.push('B-locked');
      return s;
    });

    await sleep(300);
    // Without FOR UPDATE, B would already hold its snapshot here.
    expect(bResolved).toBe(false);

    order.push('A-releasing');
    releaseA.resolve();
    await txA;
    const storageB = await txB;

    // B re-read A's committed 10_000, never the stale 8_000.
    expect(storageB.usedStorageBytes).toBe(10_000);
    expect(order).toEqual(['A-locked', 'A-releasing', 'B-locked']);
  });

  it('sequential: fills storage to exactly the cap, then rejects the next create', async () => {
    await seed(0, 10_000);

    expect(await attemptCreate(4_000)).toBe('created');
    expect(await attemptCreate(4_000)).toBe('created');
    expect(await attemptCreate(2_000)).toBe('created'); // exactly fills it
    expect(await readCounter()).toBe(10_000);

    expect(await attemptCreate(1)).toBe('rejected');
    expect(await readCounter()).toBe(10_000);
    expect(await countResources()).toBe(3);
  });

  it('the rejection is the specific, actionable PLAN_LIMIT_EXCEEDED 409', async () => {
    await seed(9_500, 10_000);
    const err = await runAs(orgId, USER_ID, () =>
      resourcesService.create({ name: 'big', sizeBytes: 1_000 }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanLimitExceededException);
    expect((err as PlanLimitExceededException).status).toBe(409);
    expect((err as PlanLimitExceededException).getBody()).toEqual({
      statusCode: 409,
      error: 'PLAN_LIMIT_EXCEEDED',
      message:
        'This resource needs 1000 B, but only 500 B of your 9.8 KB storage limit remains ' +
        '(9.3 KB in use). Delete an existing resource or upgrade your plan to add more.',
      details: { limitType: 'storage', limit: 10_000, current: 9_500, planCode: 'unknown' },
    });
  });

  it('concurrent pair: two creates that each fit alone but not together — exactly one succeeds', async () => {
    await seed(7_000, 10_000);

    const results = await Promise.all([attemptCreate(2_000), attemptCreate(2_000)]);

    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(1);
    expect(await readCounter()).toBe(9_000);
    // The rejected one wrote NOTHING — no orphan resource row.
    expect(await countResources()).toBe(1);
  });

  it('50-burst: 50 concurrent creates with room for only 2 — exactly 2 succeed', async () => {
    await seed(8_000, 10_000); // 2_000 free, each create wants 1_000

    const results = await Promise.all(Array.from({ length: 50 }, () => attemptCreate(1_000)));

    expect(results.filter((r) => r === 'created')).toHaveLength(2);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(48);
    expect(await readCounter()).toBe(10_000);
    expect(await countResources()).toBe(2);
  });

  /** The lock gives correct behaviour; the CHECK gives a ceiling even for a lock-less path. */
  it('the CHECK constraint rejects an over-ceiling write even with no lock taken', async () => {
    await seed(10_000, 10_000);
    await expect(
      transactionForOrganization(
        orgId,
        (tx) => tx.$executeRaw`
          UPDATE plan_limit_cache SET used_storage_bytes = used_storage_bytes + 1
          WHERE organization_id = ${orgId}::uuid`,
      ),
    ).rejects.toThrow(/ck_plan_limit_storage/);
  });

  it('the CHECK constraint rejects a decrement that would drive the counter negative', async () => {
    await seed(500, 10_000);
    await expect(
      transactionForOrganization(orgId, (tx) =>
        planLimits.adjustUsedStorageBytes(tx, orgId, -1_000),
      ),
    ).rejects.toThrow(/ck_plan_limit_storage_nonneg/);
  });

  it('ck_resources_size_nonneg rejects a negative resource size', async () => {
    await seed(0, 10_000);
    await expect(
      transactionForOrganization(
        orgId,
        (tx) => tx.$executeRaw`
          INSERT INTO resources (organization_id, name, size_bytes, created_by)
          VALUES (${orgId}::uuid, 'neg', -1, ${USER_ID}::uuid)`,
      ),
    ).rejects.toThrow(/ck_resources_size_nonneg/);
  });

  it('delete decrements the counter, freeing space for a create that previously did not fit', async () => {
    await seed(0, 10_000);
    const big = await runAs(orgId, USER_ID, () =>
      resourcesService.create({ name: 'big', sizeBytes: 9_000 }),
    );
    expect(await attemptCreate(2_000)).toBe('rejected');

    await runAs(orgId, USER_ID, () => resourcesService.remove(big.id));

    expect(await readCounter()).toBe(0);
    expect(await attemptCreate(2_000)).toBe('created');
  });

  it('concurrent deletes and creates keep the counter equal to the live rows', async () => {
    await seed(0, 10_000);
    const existing = [];
    for (let i = 0; i < 5; i++) {
      existing.push(
        await runAs(orgId, USER_ID, () =>
          resourcesService.create({ name: `r${i}`, sizeBytes: 1_000 }),
        ),
      );
    }
    await Promise.all([
      ...existing.map((r) => runAs(orgId, USER_ID, () => resourcesService.remove(r.id))),
      ...Array.from({ length: 10 }, () => attemptCreate(1_000)),
    ]);

    const live = await transactionForOrganization(orgId, (tx) =>
      tx.resource.aggregate({
        where: { organizationId: orgId, deletedAt: null },
        _sum: { sizeBytes: true },
      }),
    );
    expect(await readCounter()).toBe(Number(live._sum.sizeBytes ?? 0));
    expect(await readCounter()).toBeLessThanOrEqual(10_000);
  });

  it('a member may not delete a resource someone else created (403), and nothing changes', async () => {
    await seed(0, 10_000);
    const r = await runAs(orgId, USER_ID, () =>
      resourcesService.create({ name: 'mine', sizeBytes: 100 }),
    );
    await expect(
      runAs(orgId, randomUUID(), () => resourcesService.remove(r.id), [Role.ORG_MEMBER]),
    ).rejects.toMatchObject({
      status: 403,
      message: 'You may only modify resources you created',
    });
    expect(await readCounter()).toBe(100);
  });

  it('fails closed with a 503 when the org has no plan_limit_cache row yet', async () => {
    orgId = randomUUID();
    await expect(
      runAs(orgId, USER_ID, () => resourcesService.create({ name: 'early', sizeBytes: 1 })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await countResources()).toBe(0);
  });
});
