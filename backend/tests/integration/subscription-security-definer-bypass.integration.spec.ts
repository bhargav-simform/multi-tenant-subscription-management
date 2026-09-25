import { randomUUID } from 'node:crypto';
import { runGlobal, transactionForOrganization } from '../../src/lib/tenant-db';
import * as usageService from '../../src/services/usage.service';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { seedSubscription } from '../support/tenant-fixtures';

/**
 * Regression for get_usage_aggregates returning ZERO rows in production: FORCE RLS on
 * subscriptions applies to a SECURITY DEFINER function's owner, so only a BYPASSRLS
 * owner (app_rls_bypass) lets the platform-admin usage view see across tenants.
 * Exercised through the real usage.service path on a reused pooled connection.
 */
describe('get_usage_aggregates — SECURITY DEFINER genuinely bypasses FORCE RLS', () => {
  const db = new PostgresTestContainer();
  const ORG_A = randomUUID();
  const ORG_B = randomUUID();

  beforeAll(async () => {
    await db.start();
    // Each org's row inserted under its OWN scope — WITH CHECK allows nothing else.
    await seedSubscription(ORG_A, 2, 5, { usedStorageBytes: 1_024 });
    await seedSubscription(ORG_B, 4, 5);
    // The reused-connection precondition: a prior scoped transaction on this pool.
    await transactionForOrganization(ORG_A, (tx) => tx.$queryRaw`SELECT 1`);
  });
  afterAll(() => db.stop());

  it('returns the FULL cross-org aggregate, not zero rows — the platform-admin usage view', async () => {
    const rows = await usageService.getAggregates();
    expect(rows).toHaveLength(2);

    const byOrg = new Map(rows.map((r) => [r.organizationId, r]));
    expect(byOrg.get(ORG_A)).toEqual({
      organizationId: ORG_A,
      planCode: 'free',
      usedSeats: 2,
      maxSeats: 5,
      usedStorageBytes: 1_024,
      maxStorageBytes: 5_368_709_120,
    });
    expect(byOrg.get(ORG_B)?.usedSeats).toBe(4);
  });

  it("a single-org filter returns exactly that org's row, not zero rows", async () => {
    const rows = await usageService.getAggregates(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(ORG_A);
    expect(rows[0].usedSeats).toBe(2);
  });

  it('an unknown org filter returns an empty list', async () => {
    await expect(usageService.getAggregates(randomUUID())).resolves.toEqual([]);
  });

  it('the rows carry counters only — no content-bearing column exists in the function result', async () => {
    const [row] = await usageService.getAggregates(ORG_B);
    expect(Object.keys(row).sort()).toEqual([
      'maxSeats',
      'maxStorageBytes',
      'organizationId',
      'planCode',
      'usedSeats',
      'usedStorageBytes',
    ]);
  });

  it('contrast: an ordinary unscoped query on the same table returns zero rows', async () => {
    const rows = await runGlobal((tx) => tx.$queryRaw<unknown[]>`SELECT * FROM subscriptions`);
    expect(rows).toHaveLength(0);
  });

  it('the function works on a raw connection carrying the leftover empty-string setting', async () => {
    await db.asAppUser(async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org', $1, true)", [ORG_B]);
      await c.query('COMMIT');
      const res = await c.query('SELECT * FROM get_usage_aggregates(NULL)');
      expect(res.rows).toHaveLength(2);
    });
  });

  it('works even from inside a scoped transaction (it ignores ambient scope)', async () => {
    const rows = await transactionForOrganization(
      ORG_A,
      (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM get_usage_aggregates(NULL)`,
    );
    expect(rows).toHaveLength(2);
  });
});
