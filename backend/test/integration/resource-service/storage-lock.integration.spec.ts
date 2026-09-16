import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { PlanLimitCacheRepository } from '../../../apps/resource-service/src/resources/plan-limit-cache.repository';
import { PlanLimitCache } from '../../../apps/resource-service/src/resources/plan-limit-cache.entity';
import { Resource } from '../../../apps/resource-service/src/resources/resource.entity';
import { CreateResourcesAndPlanLimitCache1700000000001 } from '../../../apps/resource-service/src/database/migrations/1700000000001-CreateResourcesAndPlanLimitCache';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

/**
 * §28.1, §19.6: the REAL storage-limit concurrency proof, the exact
 * counterpart of user-service's seat-lock suite.
 *
 * The unit tests in resources.service.spec.ts prove the transaction's SHAPE
 * (lock, check, write, in that order) but CANNOT detect a missing lock —
 * their fake data source serialises every caller unconditionally. This suite
 * exercises `SELECT ... FOR UPDATE` against a real PostgreSQL row through the
 * real app_user role (NOSUPERUSER, NOBYPASSRLS, non-owner). If
 * `PlanLimitCacheRepository.lockForUpdate` ever stopped emitting FOR UPDATE —
 * the single most important line in this service — this is the suite that
 * catches it.
 *
 * VERIFIED to catch exactly that: with `.setLock('pessimistic_write')`
 * temporarily removed, the concurrent-pair and 50-burst tests below fail
 * (both/many creates succeed, breaching the ceiling). Restored, they pass.
 */
describe('resource-service storage limit — real PostgreSQL row locking (§19.6)', () => {
  jest.setTimeout(120_000);

  const db = new PostgresTestContainer();
  const planLimits = new PlanLimitCacheRepository();

  beforeAll(async () => {
    // No `schema` argument, unlike user-service's suite: resource_db's tables
    // live in the default `public` schema, which mirrors this service's real
    // DataSource setting no `schema` option at all (§14.1).
    await db.start([Resource, PlanLimitCache]);

    // The REAL migration, run as app_migrator — the same role that owns these
    // tables in production. This is what makes the RLS assertions in the
    // sibling spec meaningful, and it means the CHECK constraints under test
    // here are the ones the migration actually ships.
    await db.runMigration(async (qr) => {
      await new CreateResourcesAndPlanLimitCache1700000000001().up(qr);
    });
    await db.connectAppDataSource();
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  /**
   * Every write below runs through a transaction that sets app.current_org,
   * exactly as TenantAwareDataSource does in production — both tables are
   * FORCE ROW LEVEL SECURITY, so an unscoped connection would silently affect
   * zero rows rather than failing loudly.
   */
  async function scoped<T>(work: (manager: import('typeorm').EntityManager) => Promise<T>): Promise<T> {
    const runner = db.appDataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query("SELECT set_config('app.current_org', $1, true)", [ORG_ID]);
      const result = await work(runner.manager);
      await runner.commitTransaction();
      return result;
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  async function seed(usedStorageBytes: number, maxStorageBytes: number): Promise<void> {
    await scoped(async (manager) => {
      await manager.query(`DELETE FROM resources WHERE organization_id = $1`, [ORG_ID]);
      await manager.query(`DELETE FROM plan_limit_cache WHERE organization_id = $1`, [ORG_ID]);
      await manager.query(
        `INSERT INTO plan_limit_cache (organization_id, max_storage_bytes, used_storage_bytes)
         VALUES ($1, $2, $3)`,
        [ORG_ID, maxStorageBytes, usedStorageBytes],
      );
    });
  }

  async function readCounter(): Promise<number> {
    return scoped(async (manager) => {
      const rows = await manager.query<{ used_storage_bytes: string }[]>(
        `SELECT used_storage_bytes FROM plan_limit_cache WHERE organization_id = $1`,
        [ORG_ID],
      );
      return Number(rows[0].used_storage_bytes);
    });
  }

  /**
   * The production create() path's transaction, reproduced exactly: lock the
   * plan_limit_cache row FIRST, check the counter read under that lock,
   * insert and increment in the SAME transaction, or roll back entirely.
   */
  async function attemptCreate(sizeBytes: number): Promise<'created' | 'rejected'> {
    const runner = db.appDataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query("SELECT set_config('app.current_org', $1, true)", [ORG_ID]);

      const storage = await planLimits.lockForUpdate(ORG_ID, runner.manager);
      if (storage.usedStorageBytes + sizeBytes > storage.maxStorageBytes) {
        await runner.rollbackTransaction();
        return 'rejected';
      }

      await runner.manager.query(
        `INSERT INTO resources (organization_id, name, size_bytes, created_by)
         VALUES ($1, $2, $3, $4)`,
        [ORG_ID, 'file', sizeBytes, USER_ID],
      );
      await planLimits.adjustUsedStorageBytes(ORG_ID, sizeBytes, runner.manager);
      await runner.commitTransaction();
      return 'created';
    } catch (err) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw err;
    } finally {
      await runner.release();
    }
  }

  beforeEach(async () => {
    await seed(0, 10_000);
  });

  /**
   * §19.3's exact scenario, made observable: two transactions both try to
   * lock the same row; B must BLOCK until A commits, and must then re-read
   * A's committed value rather than the stale one it would have seen at t1.
   */
  it('SELECT ... FOR UPDATE genuinely blocks a concurrent reader until the first transaction commits', async () => {
    await seed(8_000, 10_000);

    const runnerA = db.appDataSource.createQueryRunner();
    const runnerB = db.appDataSource.createQueryRunner();
    await runnerA.connect();
    await runnerB.connect();
    await runnerA.startTransaction();
    await runnerB.startTransaction();
    await runnerA.query("SELECT set_config('app.current_org', $1, true)", [ORG_ID]);
    await runnerB.query("SELECT set_config('app.current_org', $1, true)", [ORG_ID]);

    const order: string[] = [];

    try {
      const storageA = await planLimits.lockForUpdate(ORG_ID, runnerA.manager);
      order.push('A-locked');
      expect(storageA.usedStorageBytes).toBe(8_000);

      let bResolved = false;
      const bPromise = planLimits.lockForUpdate(ORG_ID, runnerB.manager).then((s) => {
        bResolved = true;
        order.push('B-locked');
        return s;
      });

      await new Promise((r) => setTimeout(r, 300));
      // Without FOR UPDATE, B would already have resolved here.
      expect(bResolved).toBe(false);

      await planLimits.adjustUsedStorageBytes(ORG_ID, 2_000, runnerA.manager);
      await runnerA.commitTransaction();
      order.push('A-committed');

      const storageB = await bPromise;
      // B sees A's committed 10_000, never the stale 8_000.
      expect(storageB.usedStorageBytes).toBe(10_000);
      await runnerB.commitTransaction();

      expect(order).toEqual(['A-locked', 'A-committed', 'B-locked']);
    } finally {
      await runnerA.release();
      await runnerB.release();
    }
  });

  /** Required test 1 of 3: sequential fill to the cap, then reject. */
  it('sequential: fills storage to exactly the cap, then rejects the next create', async () => {
    await seed(0, 10_000);

    expect(await attemptCreate(4_000)).toBe('created');
    expect(await attemptCreate(4_000)).toBe('created');
    expect(await attemptCreate(2_000)).toBe('created'); // exactly fills it
    expect(await readCounter()).toBe(10_000);

    // One more byte does not fit.
    expect(await attemptCreate(1)).toBe('rejected');
    expect(await readCounter()).toBe(10_000);
  });

  /**
   * Required test 2 of 3 — R7's core case. Two concurrent creates, each of
   * which WOULD individually fit the remaining 3_000, but which together
   * would need 4_000. Exactly one may succeed.
   */
  it('concurrent pair: two creates that each fit alone but not together — exactly one succeeds', async () => {
    await seed(7_000, 10_000);

    const [a, b] = await Promise.all([attemptCreate(2_000), attemptCreate(2_000)]);
    const results = [a, b];

    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(1);
    expect(await readCounter()).toBe(9_000);

    // And the rejected one wrote NOTHING — no orphan resource row.
    const rows = await scoped((manager) =>
      manager.query<{ count: string }[]>(
        `SELECT COUNT(*) AS count FROM resources WHERE organization_id = $1`,
        [ORG_ID],
      ),
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  /**
   * Required test 3 of 3 — the brief's stretch case, mirroring user-service's
   * 50-burst exactly: 50 simultaneous creates with room for only 2.
   */
  it('50-burst: 50 concurrent creates with only 2 slots of storage free — exactly 2 succeed', async () => {
    await seed(8_000, 10_000); // 2_000 free, each create wants 1_000

    const results = await Promise.all(Array.from({ length: 50 }, () => attemptCreate(1_000)));

    expect(results.filter((r) => r === 'created')).toHaveLength(2);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(48);
    expect(await readCounter()).toBe(10_000);

    const rows = await scoped((manager) =>
      manager.query<{ count: string }[]>(
        `SELECT COUNT(*) AS count FROM resources WHERE organization_id = $1`,
        [ORG_ID],
      ),
    );
    expect(Number(rows[0].count)).toBe(2);
  }, 60_000);

  /**
   * §19.4's backstop. The lock gives correct behaviour; the CHECK gives a
   * guaranteed ceiling even for a future code path that skipped the lock.
   * Both must fail for the limit to be breached.
   */
  it('the CHECK constraint rejects an over-ceiling write even with no lock taken at all', async () => {
    await seed(10_000, 10_000);

    await expect(
      scoped((manager) =>
        manager.query(
          `UPDATE plan_limit_cache SET used_storage_bytes = used_storage_bytes + 1
           WHERE organization_id = $1`,
          [ORG_ID],
        ),
      ),
    ).rejects.toThrow(/ck_plan_limit_storage/);
  });

  it('the CHECK constraint rejects a decrement that would drive the counter negative', async () => {
    await seed(500, 10_000);

    await expect(
      scoped((manager) =>
        manager.query(
          `UPDATE plan_limit_cache SET used_storage_bytes = used_storage_bytes - 1000
           WHERE organization_id = $1`,
          [ORG_ID],
        ),
      ),
    ).rejects.toThrow(/ck_plan_limit_storage_nonneg/);
  });

  /** A delete frees storage under the same lock-first ordering create uses. */
  it('delete decrements the counter, freeing space for a create that previously did not fit', async () => {
    await seed(0, 10_000);
    expect(await attemptCreate(9_000)).toBe('created');
    expect(await attemptCreate(2_000)).toBe('rejected');

    await scoped(async (manager) => {
      await planLimits.lockForUpdate(ORG_ID, manager);
      await manager.query(
        `UPDATE resources SET deleted_at = now() WHERE organization_id = $1 AND deleted_at IS NULL`,
        [ORG_ID],
      );
      await planLimits.adjustUsedStorageBytes(ORG_ID, -9_000, manager);
    });

    expect(await readCounter()).toBe(0);
    expect(await attemptCreate(2_000)).toBe('created');
  });
});
