import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { SubscriptionSeatRepository } from '../../../apps/user-service/src/subscriptions/subscription-seat.repository';
import { SubscriptionSeatView } from '../../../apps/user-service/src/subscriptions/subscription.entity';

/**
 * §28.1, §19: the REAL T3 test. Unlike the fake-serialised unit test in
 * users.service.spec.ts (which proves the transaction SHAPE — lock, check,
 * write, in that order — but cannot detect a missing lock, since its fake
 * serialises every caller unconditionally), this test exercises
 * `SELECT ... FOR UPDATE` against a real PostgreSQL row, through the exact
 * same role (app_user, NOSUPERUSER/NOBYPASSRLS) every service runs as in
 * production. If `SubscriptionSeatRepository.lockForUpdate` ever stopped
 * emitting `FOR UPDATE` — the single most important line in this service —
 * this is the test that would catch it; the unit test would not.
 *
 * This is a genuine 60+ second test (container startup) — run as part of the
 * integration suite, not the fast unit-test loop.
 */
describe('SubscriptionSeatRepository — real PostgreSQL row locking (T3)', () => {
  jest.setTimeout(120_000);

  const db = new PostgresTestContainer();
  const repo = new SubscriptionSeatRepository();
  const ORG_ID = '11111111-1111-1111-1111-111111111111';

  beforeAll(async () => {
    await db.start([SubscriptionSeatView]);

    await db.runMigration(async (qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS subs`);
      await qr.query(`
        CREATE TABLE "subs"."subscriptions" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "organization_id" uuid NOT NULL,
          "used_seats" int NOT NULL DEFAULT 0,
          "max_seats_snapshot" int NOT NULL,
          CONSTRAINT "uq_subscriptions_org" UNIQUE ("organization_id"),
          CONSTRAINT "ck_subscriptions_seats" CHECK ("used_seats" <= "max_seats_snapshot"),
          CONSTRAINT "ck_subscriptions_seats_nonneg" CHECK ("used_seats" >= 0)
        )
      `);
    });
    await db.grantAppUserAccessToSchema('subs');
    await db.connectAppDataSource();
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  async function seedSubscription(usedSeats: number, maxSeats: number): Promise<void> {
    await db.appDataSource.query(
      `DELETE FROM "subs"."subscriptions" WHERE organization_id = $1`,
      [ORG_ID],
    );
    await db.appDataSource.query(
      `INSERT INTO "subs"."subscriptions" (organization_id, used_seats, max_seats_snapshot)
       VALUES ($1, $2, $3)`,
      [ORG_ID, usedSeats, maxSeats],
    );
  }

  /**
   * Reproduces §19.2/§19.3's exact scenario: two transactions, both
   * SELECT ... FOR UPDATE the same row, both read usedSeats < max, both
   * would (incorrectly) proceed if there were no lock. With the real lock,
   * transaction B's SELECT blocks until A commits, and B then observes A's
   * committed increment — proving the FOR UPDATE, not application logic,
   * is what makes the invariant hold.
   */
  it('SELECT ... FOR UPDATE genuinely blocks a concurrent reader until the first transaction commits', async () => {
    await seedSubscription(4, 5);

    const runnerA = db.appDataSource.createQueryRunner();
    const runnerB = db.appDataSource.createQueryRunner();
    await runnerA.connect();
    await runnerB.connect();
    await runnerA.startTransaction();
    await runnerB.startTransaction();

    const order: string[] = [];

    try {
      // A acquires the lock and holds it.
      const seatA = await repo.lockForUpdate(ORG_ID, runnerA.manager);
      order.push('A-locked');
      expect(seatA.usedSeats).toBe(4);

      // B's lock attempt on the SAME row must block — race it against a
      // timer to prove it does not resolve immediately.
      let bResolved = false;
      const bPromise = repo.lockForUpdate(ORG_ID, runnerB.manager).then((seat) => {
        bResolved = true;
        order.push('B-locked');
        return seat;
      });

      await new Promise((r) => setTimeout(r, 300));
      // If FOR UPDATE were missing, B would already have resolved here.
      expect(bResolved).toBe(false);

      // A increments and commits — releasing the lock.
      await repo.adjustUsedSeats(ORG_ID, 1, runnerA.manager);
      await runnerA.commitTransaction();
      order.push('A-committed');

      // NOW B's blocked SELECT ... FOR UPDATE resolves, and must see A's
      // committed write (5), not the stale value (4) it would have seen
      // had it read before A committed.
      const seatB = await bPromise;
      expect(seatB.usedSeats).toBe(5);
      await runnerB.commitTransaction();

      expect(order).toEqual(['A-locked', 'A-committed', 'B-locked']);
    } finally {
      await runnerA.release();
      await runnerB.release();
    }
  });

  it('two genuinely concurrent invite-shaped transactions with 1 seat free: exactly one increments, one sees the limit', async () => {
    await seedSubscription(4, 5);

    async function attemptInvite(): Promise<'invited' | 'rejected'> {
      const runner = db.appDataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        const seat = await repo.lockForUpdate(ORG_ID, runner.manager);
        if (seat.usedSeats >= seat.maxSeatsSnapshot) {
          await runner.rollbackTransaction();
          return 'rejected';
        }
        await repo.adjustUsedSeats(ORG_ID, 1, runner.manager);
        await runner.commitTransaction();
        return 'invited';
      } finally {
        await runner.release();
      }
    }

    const [resultA, resultB] = await Promise.all([attemptInvite(), attemptInvite()]);
    const results = [resultA, resultB];

    expect(results.filter((r) => r === 'invited')).toHaveLength(1);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(1);

    const [{ used_seats: finalUsedSeats }] = await db.appDataSource.query<
      { used_seats: number }[]
    >(`SELECT used_seats FROM "subs"."subscriptions" WHERE organization_id = $1`, [ORG_ID]);
    expect(finalUsedSeats).toBe(5);
  });

  it('50-burst (real Postgres): 50 concurrent invite-shaped transactions, 2 seats free — exactly 2 succeed', async () => {
    await seedSubscription(3, 5);

    async function attemptInvite(): Promise<'invited' | 'rejected'> {
      const runner = db.appDataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        const seat = await repo.lockForUpdate(ORG_ID, runner.manager);
        if (seat.usedSeats >= seat.maxSeatsSnapshot) {
          await runner.rollbackTransaction();
          return 'rejected';
        }
        await repo.adjustUsedSeats(ORG_ID, 1, runner.manager);
        await runner.commitTransaction();
        return 'invited';
      } finally {
        await runner.release();
      }
    }

    const results = await Promise.all(Array.from({ length: 50 }, () => attemptInvite()));

    expect(results.filter((r) => r === 'invited')).toHaveLength(2);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(48);

    const [{ used_seats: finalUsedSeats }] = await db.appDataSource.query<
      { used_seats: number }[]
    >(`SELECT used_seats FROM "subs"."subscriptions" WHERE organization_id = $1`, [ORG_ID]);
    expect(finalUsedSeats).toBe(5);
  }, 60_000);

  it('the CHECK constraint backstop rejects a write that would exceed the limit even without the lock', async () => {
    await seedSubscription(5, 5);

    await expect(
      db.appDataSource.query(
        `UPDATE "subs"."subscriptions" SET used_seats = used_seats + 1 WHERE organization_id = $1`,
        [ORG_ID],
      ),
    ).rejects.toThrow(/ck_subscriptions_seats/);
  });
});
