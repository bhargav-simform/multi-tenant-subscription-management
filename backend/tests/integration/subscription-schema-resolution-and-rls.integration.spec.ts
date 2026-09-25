import { randomUUID } from 'node:crypto';
import { NotFoundException, PlanLimitExceededException } from '../../src/lib/http-errors';
import { runGlobal, transactionForOrganization } from '../../src/lib/tenant-db';
import * as history from '../../src/models/subscription-history.model';
import * as plansService from '../../src/services/plans.service';
import * as subscriptionsService from '../../src/services/subscriptions.service';
import { Role } from '../../src/types/constants';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { runAs, seedSubscription } from '../support/tenant-fixtures';

/**
 * Port of the subscription-service regression for two real bugs:
 *
 * 1. Plan/Subscription entities not resolving outside the `subs` schema. Now a single
 *    public schema: asserted as "the plans catalogue and subscriptions resolve through
 *    app_user, plans readable unscoped (no RLS), subscriptions only scoped".
 * 2. getCurrent() running OUTSIDE any RLS scope and so 404ing for every org — and
 *    changePlan(), which ends in getCurrent(), reporting a committed change as a 404.
 */
describe('subscriptions: schema resolution + RLS-scoped getCurrent (regression)', () => {
  const db = new PostgresTestContainer();
  const ORG_ID = randomUUID();
  const USER_ID = randomUUID();

  beforeAll(async () => {
    await db.start();
    await seedSubscription(ORG_ID, 2, 5);
  });
  afterAll(() => db.stop());

  it('the plans catalogue resolves via runGlobal (global data, no RLS) with the seeded limits', async () => {
    const free = await plansService.findByCode('free');
    expect(free).toMatchObject({ code: 'free', name: 'Free', maxUsers: 5, isActive: true });
    expect(free?.maxStorageBytes).toBe(5_368_709_120);

    const all = await plansService.listActive();
    expect(all.map((p) => p.code).sort()).toEqual(['enterprise', 'free', 'pro']);
    await expect(plansService.findDefault()).resolves.toMatchObject({ code: 'free' });
  });

  it('plans has no RLS and app_user may only read it', async () => {
    const [cls] = await db.prisma.$queryRaw<{ relrowsecurity: boolean }[]>`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'plans'`;
    expect(cls.relrowsecurity).toBe(false);
    await expect(
      runGlobal((tx) => tx.$executeRaw`UPDATE plans SET max_users = 9999 WHERE code = 'free'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("getCurrent() returns the caller's own subscription (was unconditionally 404 before the fix)", async () => {
    const result = await runAs(ORG_ID, USER_ID, () => subscriptionsService.getCurrent());
    expect(result).toEqual({
      planCode: 'free',
      planName: 'Free',
      status: 'active',
      usedSeats: 2,
      maxSeats: 5,
      usedStorageBytes: 0,
      maxStorageBytes: 5_368_709_120,
    });
  });

  it('getCurrent() throws NotFoundException for an org with no subscription row', async () => {
    await expect(
      runAs(randomUUID(), USER_ID, () => subscriptionsService.getCurrent()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getCurrent() in a platform-admin context is a plain error (500), never a 404', async () => {
    const err = await runAs(null, USER_ID, () => subscriptionsService.getCurrent(), [
      Role.PLATFORM_ADMIN,
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });

  it('RLS isolates subscription reads by organization', async () => {
    const otherOrgId = randomUUID();
    await seedSubscription(otherOrgId, 1, 5);

    const mine = await runAs(ORG_ID, USER_ID, () => subscriptionsService.getCurrent());
    expect(mine.usedSeats).toBe(2); // ORG_ID's own row, unaffected

    // An unscoped read of the table sees nothing at all.
    const unscoped = await db.prisma.$queryRaw<unknown[]>`SELECT * FROM subscriptions`;
    expect(unscoped).toHaveLength(0);

    // app_user has no DELETE on subscriptions (kept from the old grants).
    await expect(
      transactionForOrganization(ORG_ID, (tx) => tx.$executeRaw`DELETE FROM subscriptions`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('changePlan() commits, records history, and returns the NEW subscription (not a 404)', async () => {
    const orgId = randomUUID();
    await seedSubscription(orgId, 3, 5);

    const result = await runAs(orgId, USER_ID, () => subscriptionsService.changePlan('pro'));
    expect(result).toMatchObject({ planCode: 'pro', planName: 'Pro', usedSeats: 3, maxSeats: 25 });
    expect(result.maxStorageBytes).toBe(53_687_091_200);

    const rows = await transactionForOrganization(orgId, (tx) =>
      tx.subscriptionHistory.findMany({ where: { organizationId: orgId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].changedBy).toBe(USER_ID);
  });

  it('a downgrade that would breach the target plan is a specific 409 and writes nothing', async () => {
    const orgId = randomUUID();
    await transactionForOrganization(
      orgId,
      (tx) => tx.$executeRaw`
        INSERT INTO subscriptions (organization_id, plan_id, used_seats, max_seats_snapshot, max_storage_snapshot)
        VALUES (${orgId}::uuid, (SELECT id FROM plans WHERE code = 'pro'), 7, 25, 53687091200)`,
    );

    const err = await runAs(orgId, USER_ID, () => subscriptionsService.changePlan('free')).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PlanLimitExceededException);
    expect((err as PlanLimitExceededException).getBody()).toEqual({
      statusCode: 409,
      error: 'PLAN_LIMIT_EXCEEDED',
      message:
        'Your organisation holds 7 seats and 0.0 GB. The Free plan allows 5 seats and 5.0 GB. ' +
        'Remove 2 users or revoke pending invitations before downgrading.',
      details: { limitType: 'seats', limit: 5, current: 7, planCode: 'free' },
    });

    const after = await runAs(orgId, USER_ID, () => subscriptionsService.getCurrent());
    expect(after.planCode).toBe('pro');
  });

  it('a code outside the plans_code enum is a plain (500-class) error, as it was under TypeORM', async () => {
    // Unreachable over HTTP (ChangePlanDto's @IsEnum rejects it first). The old
    // findOne() hit Postgres' enum cast and threw too, so neither was ever a 404.
    const err = await runAs(ORG_ID, USER_ID, () =>
      subscriptionsService.changePlan('platinum'),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });

  it('subscription_history is RLS-scoped: org A cannot plant history for org B', async () => {
    const free = await plansService.findDefault();
    await expect(
      transactionForOrganization(ORG_ID, (tx) =>
        history.record(tx, {
          organizationId: randomUUID(),
          fromPlanId: null,
          toPlanId: free.id,
          changedBy: USER_ID,
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('assignDefaultPlan() creates the free subscription the seat lock depends on', async () => {
    const orgId = randomUUID();
    const { subscriptionId } = await subscriptionsService.assignDefaultPlan(orgId);
    const sub = await transactionForOrganization(orgId, (tx) =>
      tx.subscription.findUnique({ where: { organizationId: orgId } }),
    );
    expect(sub?.id).toBe(subscriptionId);
    expect(sub).toMatchObject({ usedSeats: 0, maxSeatsSnapshot: 5 });
  });
});
