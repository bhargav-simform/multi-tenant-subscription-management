import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { enableTenantRls, TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { EventPublisher } from '@app/kafka';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { Plan, PlanCode } from '../../../apps/subscription-service/src/plans/plan.entity';
import { PlanRepository } from '../../../apps/subscription-service/src/plans/plan.repository';
import { Subscription } from '../../../apps/subscription-service/src/subscriptions/subscription.entity';
import { SubscriptionRepository } from '../../../apps/subscription-service/src/subscriptions/subscription.repository';
import { SubscriptionsService } from '../../../apps/subscription-service/src/subscriptions/subscriptions.service';
import { SubscriptionHistory } from '../../../apps/subscription-service/src/subscriptions/subscription-history.entity';

/**
 * Regression test for two real bugs found via empirical Postgres testing,
 * both in code that had zero prior integration coverage:
 *
 * 1. `Plan`/`Subscription` use bare `@Entity()` names with no schema
 *    qualification — Postgres's default search_path ("$user", public) does
 *    not include `subs`, so every query against them fails to resolve
 *    unless the DataSource itself carries `schema: 'subs'` (app.module.ts).
 * 2. `SubscriptionsService.getCurrent()` used to call
 *    `findByOrganizationId` with NO transaction manager, hitting the raw
 *    DataSource outside any RLS scope. `subs.subscriptions` has FORCE ROW
 *    LEVEL SECURITY (applied by user-service's migration, since it creates
 *    the table) — a connection with no app.current_org set returns zero
 *    rows unconditionally, so `GET /subscriptions/current` would 404 for
 *    every organisation in production, and worse, `changePlan()` ends by
 *    calling `getCurrent()`, so a successful, committed, event-published
 *    plan change would still surface as a 404 to the caller.
 *
 * This test builds the minimal real shape of both tables (as user-service's
 * and subscription-service's actual migrations create/extend them) against
 * a real Postgres container, through the real app_user role, using
 * `enableTenantRls` — the same helper the real migrations call — so the
 * policy shape matches production exactly.
 */
describe('subscription-service: entity schema resolution + RLS-scoped getCurrent (regression)', () => {
  jest.setTimeout(120_000);

  const db = new PostgresTestContainer();
  const ORG_ID = randomUUID();

  let tenantAwareDataSource: TenantAwareDataSource;
  let tenantContext: TenantContextStore;
  let planRepository: PlanRepository;
  let subscriptionRepository: SubscriptionRepository;
  let service: SubscriptionsService;
  let freePlanId: string;

  beforeAll(async () => {
    // Mirrors apps/subscription-service/src/app.module.ts: schema: 'subs' is
    // the fix under test.
    await db.start([Plan, Subscription, SubscriptionHistory], 'subs');

    await db.runMigration(async (qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS subs`);

      await qr.query(`CREATE TYPE "subs"."plans_code_enum" AS ENUM ('free', 'pro', 'enterprise')`);
      await qr.query(`
        CREATE TABLE "subs"."plans" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "code" "subs"."plans_code_enum" NOT NULL,
          "name" varchar(255) NOT NULL,
          "max_users" int NOT NULL,
          "max_storage_bytes" bigint NOT NULL,
          "is_active" boolean NOT NULL DEFAULT true,
          CONSTRAINT "uq_plans_code" UNIQUE ("code")
        )
      `);
      const rows = (await qr.query(`
        INSERT INTO "subs"."plans" (code, name, max_users, max_storage_bytes, is_active)
        VALUES ('free', 'Free', 5, 5368709120, true)
        RETURNING id
      `)) as { id: string }[];
      freePlanId = rows[0].id;

      // Minimal subs.subscriptions, exactly as user-service's migration
      // creates it, PLUS the columns subscription-service's migration adds
      // via ALTER TABLE (§32.3 "migration sequencing") — collapsed into one
      // CREATE here since this test only needs the final shape.
      await qr.query(`CREATE TYPE "subs"."subscriptions_status_enum" AS ENUM ('active', 'cancelled')`);
      await qr.query(`
        CREATE TABLE "subs"."subscriptions" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "organization_id" uuid NOT NULL UNIQUE,
          "plan_id" uuid NOT NULL REFERENCES "subs"."plans"("id"),
          "status" "subs"."subscriptions_status_enum" NOT NULL DEFAULT 'active',
          "used_seats" int NOT NULL DEFAULT 0,
          "used_storage_bytes" bigint NOT NULL DEFAULT 0,
          "max_seats_snapshot" int NOT NULL,
          "max_storage_snapshot" bigint NOT NULL,
          "current_period_end" timestamptz,
          "version" int NOT NULL DEFAULT 0,
          "created_at" timestamptz NOT NULL DEFAULT now(),
          "updated_at" timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT "ck_subscriptions_seats" CHECK ("used_seats" <= "max_seats_snapshot"),
          CONSTRAINT "ck_subscriptions_storage" CHECK ("used_storage_bytes" <= "max_storage_snapshot")
        )
      `);
      await enableTenantRls(qr, 'subs.subscriptions');
    });
    await db.grantAppUserAccessToSchema('subs');
    await db.connectAppDataSource();

    tenantContext = new TenantContextStore();
    tenantAwareDataSource = new TenantAwareDataSource(db.appDataSource, tenantContext);
    planRepository = new PlanRepository(tenantAwareDataSource);
    subscriptionRepository = new SubscriptionRepository();

    const publisher = { publish: async () => undefined } as unknown as EventPublisher;
    const noopHistory = { record: async () => undefined };
    service = new SubscriptionsService(
      tenantAwareDataSource,
      tenantContext,
      publisher,
      planRepository,
      subscriptionRepository,
      noopHistory,
    );
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  function withContext<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { userId: 'test-user', organizationId, roles: [], correlationId: randomUUID(), iat: 0, exp: 0 },
      work,
    );
  }

  it('PlanRepository resolves the bare-named Plan entity via runGlobal (no RLS, but real schema resolution)', async () => {
    const plan = await planRepository.findByCode(PlanCode.FREE);
    expect(plan?.id).toBe(freePlanId);
    expect(plan?.maxUsers).toBe(5);
  });

  it('getCurrent() returns the subscription for the caller\'s own org (proves the fix: was unconditionally 404 before)', async () => {
    await tenantAwareDataSource.transactionForOrganization(ORG_ID, async (manager) => {
      await manager.getRepository(Subscription).save({
        id: randomUUID(),
        organizationId: ORG_ID,
        planId: freePlanId,
        usedSeats: 2,
        usedStorageBytes: 0,
        maxSeatsSnapshot: 5,
        maxStorageSnapshot: 5_368_709_120,
        currentPeriodEnd: null,
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    const result = await withContext(ORG_ID, () => service.getCurrent());

    expect(result.planCode).toBe(PlanCode.FREE);
    expect(result.usedSeats).toBe(2);
    expect(result.maxSeats).toBe(5);
  });

  it('getCurrent() throws NotFoundException for an org with no subscription row, not a false success', async () => {
    await expect(withContext(randomUUID(), () => service.getCurrent())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('RLS still isolates subscription reads by organization through the bare-named entity', async () => {
    const otherOrgId = randomUUID();
    await tenantAwareDataSource.transactionForOrganization(otherOrgId, async (manager) => {
      await manager.getRepository(Subscription).save({
        id: randomUUID(),
        organizationId: otherOrgId,
        planId: freePlanId,
        usedSeats: 1,
        usedStorageBytes: 0,
        maxSeatsSnapshot: 5,
        maxStorageSnapshot: 5_368_709_120,
        currentPeriodEnd: null,
        version: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    // ORG_ID (from the earlier test) must not see otherOrgId's row, and vice
    // versa — reading as ORG_ID must still return ORG_ID's own subscription.
    const result = await withContext(ORG_ID, () => service.getCurrent());
    expect(result.usedSeats).toBe(2); // ORG_ID's own row, unaffected by otherOrgId's insert
  });
});
