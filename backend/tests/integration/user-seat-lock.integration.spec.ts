import { randomUUID } from 'node:crypto';
import { PlanLimitExceededException } from '../../src/lib/http-errors';
import { transactionForOrganization } from '../../src/lib/tenant-db';
import * as seats from '../../src/models/subscription-seat.model';
import * as usersService from '../../src/services/users.service';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { deferred, runAs, seedSubscription, seedUsers, sleep } from '../support/tenant-fixtures';

const ADMIN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/**
 * T3 — the REAL seat-limit test. The unit test's fake serialises every caller, so it
 * proves the transaction's SHAPE but cannot detect a missing lock. This drives
 * users.service.invite() against a real subscriptions row through app_user, so if
 * subscription-seat.model lockForUpdate() ever stopped emitting FOR UPDATE, the
 * concurrent-pair and 50-burst cases fail here.
 *
 * Every variant asserts the same invariant (a seat is held by an active user OR a
 * pending unexpired invitation):
 *
 *     used_seats == active users + pending unexpired invitations
 */
describe('seat limit — real PostgreSQL row locking (T3)', () => {
  const db = new PostgresTestContainer();
  let orgId: string;

  beforeAll(() => db.start());
  afterAll(() => db.stop());

  /** A fresh org with `held` real users holding seats, on a `max`-seat plan. */
  async function seedOrg(held: number, max: number): Promise<void> {
    orgId = randomUUID();
    await seedUsers(orgId, held);
    await seedSubscription(orgId, held, max);
  }

  async function counters() {
    return transactionForOrganization(orgId, async (tx) => {
      const [sub] = await tx.$queryRaw<{ used_seats: number }[]>`
        SELECT used_seats FROM subscriptions WHERE organization_id = ${orgId}::uuid`;
      const activeUsers = await tx.user.count({
        where: { organizationId: orgId, status: 'active', deletedAt: null },
      });
      const pendingInvitations = await tx.invitation.count({
        where: {
          organizationId: orgId,
          acceptedAt: null,
          revokedAt: null,
          deletedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      return { usedSeats: sub.used_seats, activeUsers, pendingInvitations };
    });
  }

  async function expectInvariant(expectedUsedSeats: number): Promise<void> {
    const c = await counters();
    expect(c.usedSeats).toBe(expectedUsedSeats);
    expect(c.usedSeats).toBe(c.activeUsers + c.pendingInvitations);
  }

  async function attemptInvite(email = `${randomUUID()}@example.com`) {
    try {
      await runAs(orgId, ADMIN_ID, () => usersService.invite({ email, role: 'org_member' }));
      return 'invited' as const;
    } catch (err) {
      if (err instanceof PlanLimitExceededException) return 'rejected' as const;
      throw err;
    }
  }

  it('SELECT ... FOR UPDATE genuinely blocks a concurrent locker until the first commits', async () => {
    await seedOrg(4, 5);
    const order: string[] = [];
    const aLocked = deferred();
    const releaseA = deferred();

    const txA = transactionForOrganization(orgId, async (tx) => {
      const seat = await seats.lockForUpdate(tx, orgId);
      order.push('A-locked');
      expect(seat.usedSeats).toBe(4);
      aLocked.resolve();
      await releaseA.promise;
      await seats.adjustUsedSeats(tx, orgId, 1);
    });
    await aLocked.promise;

    let bResolved = false;
    const txB = transactionForOrganization(orgId, async (tx) => {
      const seat = await seats.lockForUpdate(tx, orgId);
      bResolved = true;
      order.push('B-locked');
      return seat;
    });

    await sleep(300);
    // If FOR UPDATE were missing, B would already have resolved here.
    expect(bResolved).toBe(false);

    order.push('A-releasing');
    releaseA.resolve();
    await txA;
    // B observes A's committed increment (5), not the stale 4.
    expect((await txB).usedSeats).toBe(5);
    expect(order).toEqual(['A-locked', 'A-releasing', 'B-locked']);
  });

  it('sequential fill-to-cap: invites succeed until the plan is full, then 409', async () => {
    await seedOrg(1, 5);
    for (let i = 0; i < 4; i++) expect(await attemptInvite()).toBe('invited');
    expect(await attemptInvite()).toBe('rejected');
    await expectInvariant(5);
  });

  it('the 409 names the plan limit and what holds the seats', async () => {
    await seedOrg(3, 5);
    await attemptInvite();
    await attemptInvite();

    const err = await runAs(orgId, ADMIN_ID, () =>
      usersService.invite({ email: 'one-too-many@example.com', role: 'org_member' }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanLimitExceededException);
    expect((err as PlanLimitExceededException).getBody()).toEqual({
      statusCode: 409,
      error: 'PLAN_LIMIT_EXCEEDED',
      message:
        'Your plan allows 5 seats. All 5 are held (3 users, 2 pending invitations). ' +
        'Remove a user or revoke a pending invitation before inviting another.',
      details: {
        limitType: 'seats',
        limit: 5,
        current: 5,
        planCode: 'unknown',
        activeUsers: 3,
        pendingInvitations: 2,
      },
    });
  });

  it('concurrent pair on a 5-seat plan with 4 held: exactly one succeeds, used_seats = 5', async () => {
    await seedOrg(4, 5);
    const results = await Promise.all([attemptInvite(), attemptInvite()]);

    expect(results.filter((r) => r === 'invited')).toHaveLength(1);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(1);
    await expectInvariant(5);
  });

  it('50-burst: 50 concurrent invites with 2 seats free — exactly 2 succeed', async () => {
    await seedOrg(3, 5);
    const results = await Promise.all(Array.from({ length: 50 }, () => attemptInvite()));

    expect(results.filter((r) => r === 'invited')).toHaveLength(2);
    expect(results.filter((r) => r === 'rejected')).toHaveLength(48);
    await expectInvariant(5);
  });

  it('50-burst with the SAME email: one invitation, 49 conflicts, one seat taken', async () => {
    await seedOrg(1, 5);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        runAs(orgId, ADMIN_ID, () =>
          usersService.invite({ email: 'dup@example.com', role: 'org_member' }),
        ),
      ),
    );

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(rejected).toHaveLength(49);
    for (const r of rejected)
      expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    await expectInvariant(2);
  });

  it('revoke releases the seat so the next invite fits — even when they race', async () => {
    await seedOrg(3, 5);
    const first = await runAs(orgId, ADMIN_ID, () =>
      usersService.invite({ email: 'first@example.com', role: 'org_member' }),
    );
    await attemptInvite();
    await expectInvariant(5);

    // Revoke and a burst of invites race; the revoke frees exactly one seat.
    const [, ...results] = await Promise.all([
      runAs(orgId, ADMIN_ID, () => usersService.revokeInvitation(first.invitationId)),
      ...Array.from({ length: 10 }, () => attemptInvite()),
    ]);
    expect(results.filter((r) => r === 'invited').length).toBeLessThanOrEqual(1);
    const c = await counters();
    expect(c.usedSeats).toBe(c.activeUsers + c.pendingInvitations);
    expect(c.usedSeats).toBeLessThanOrEqual(5);
  });

  it('removing a user frees their seat; used_seats tracks it exactly', async () => {
    await seedOrg(5, 5);
    expect(await attemptInvite()).toBe('rejected');

    const [, memberId] = await transactionForOrganization(orgId, (tx) =>
      tx.user.findMany({ where: { organizationId: orgId }, orderBy: { lastName: 'asc' } }),
    ).then((rows) => rows.map((r) => r.id));
    await runAs(orgId, ADMIN_ID, () => usersService.removeUser(memberId));
    await expectInvariant(4);

    expect(await attemptInvite()).toBe('invited');
    await expectInvariant(5);
  });

  it('accepting an invitation is seat-neutral (the invitation already held it)', async () => {
    await seedOrg(1, 5);
    const { tokenForDev } = await runAs(orgId, ADMIN_ID, () =>
      usersService.invite({ email: 'joiner@example.com', role: 'org_member' }),
    );
    await expectInvariant(2);

    const user = await usersService.acceptInvitation(tokenForDev, {
      firstName: 'Jo',
      lastName: 'Iner',
      password: 'correct-horse-battery',
    });
    expect(user.organizationId).toBe(orgId);
    await expectInvariant(2);
  });

  it('the CHECK constraint backstop rejects an over-limit write even without the lock', async () => {
    await seedOrg(0, 5);
    await seedSubscription(orgId, 5, 5);
    await expect(
      transactionForOrganization(orgId, (tx) => seats.adjustUsedSeats(tx, orgId, 1)),
    ).rejects.toThrow(/ck_subscriptions_seats/);
  });

  it('the non-negative CHECK rejects a decrement below zero', async () => {
    await seedOrg(0, 5);
    await expect(
      transactionForOrganization(orgId, (tx) => seats.adjustUsedSeats(tx, orgId, -1)),
    ).rejects.toThrow(/ck_subscriptions_seats_nonneg/);
  });

  it('a missing subscription row is a 500-class invariant violation, not a permissive default', async () => {
    orgId = randomUUID();
    await expect(attemptInvite()).rejects.toMatchObject({ status: 500 });
  });
});
