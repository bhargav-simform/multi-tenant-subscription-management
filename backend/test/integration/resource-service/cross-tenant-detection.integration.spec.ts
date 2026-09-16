import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { TenantContextStore } from '@app/tenant-context';
import { TenantAwareDataSource } from '@app/database';
import { EventPublisher } from '@app/kafka';
import { Role } from '@app/common';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { ResourceRepository } from '../../../apps/resource-service/src/resources/resource.repository';
import { PlanLimitCacheRepository } from '../../../apps/resource-service/src/resources/plan-limit-cache.repository';
import { Resource } from '../../../apps/resource-service/src/resources/resource.entity';
import { PlanLimitCache } from '../../../apps/resource-service/src/resources/plan-limit-cache.entity';
import { ResourcesService } from '../../../apps/resource-service/src/resources/resources.service';
import { CreateResourcesAndPlanLimitCache1700000000001 } from '../../../apps/resource-service/src/database/migrations/1700000000001-CreateResourcesAndPlanLimitCache';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/**
 * §13.9, §32.4: the reused-pooled-connection regression test the schema-fix
 * bug demanded — see rls-isolation.integration.spec.ts's header comment for
 * the full story. That suite proves a raw query on a reused connection
 * returns zero rows; THIS suite proves the actual H1 endpoint
 * (`ResourcesService.getById`, exercised through its real
 * `TenantAwareDataSource` + `runGlobal()` cross-tenant probe, not a mock of
 * either) still returns a clean 404 — never a 500 — when that probe runs on
 * a connection this same test file has already used for a scoped
 * transaction. A unit test cannot catch this: every existing unit test mocks
 * `runGlobal()`, so it asserts the probe was CALLED, never that it WORKS.
 */
describe('ResourcesService.getById — cross-tenant detection on a reused connection (§32.4)', () => {
  jest.setTimeout(120_000);

  const db = new PostgresTestContainer();
  const tenantContext = new TenantContextStore();
  const resourceRepo = new ResourceRepository(tenantContext);
  const planLimitRepo = new PlanLimitCacheRepository();

  let tenantDataSource: TenantAwareDataSource;
  let service: ResourcesService;
  let publishedEvents: { eventType: string; payload: unknown }[];

  beforeAll(async () => {
    await db.start([Resource, PlanLimitCache]);
    await db.runMigration(async (qr) => {
      await new CreateResourcesAndPlanLimitCache1700000000001().up(qr);
    });
    await db.connectAppDataSource();

    tenantDataSource = new TenantAwareDataSource(db.appDataSource, tenantContext);

    publishedEvents = [];
    const fakePublisher = {
      publish: async (_topic: string, event: { eventType: string; payload: unknown }) => {
        publishedEvents.push(event);
      },
    } as unknown as EventPublisher;

    service = new ResourcesService(
      tenantDataSource,
      tenantContext,
      fakePublisher,
      resourceRepo,
      planLimitRepo,
    );
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  function contextFor(organizationId: string) {
    return {
      userId: USER_A,
      organizationId,
      roles: [Role.ORG_ADMIN],
      correlationId: randomUUID(),
      iat: 0,
      exp: 0,
    };
  }

  let orgBResourceId: string;

  beforeEach(async () => {
    publishedEvents = [];

    for (const org of [ORG_A, ORG_B]) {
      await tenantDataSource.transactionForOrganization(org, (manager) =>
        manager.query(`DELETE FROM resources`),
      );
      await tenantDataSource.transactionForOrganization(org, (manager) =>
        manager.query(
          `INSERT INTO plan_limit_cache (organization_id, max_storage_bytes, used_storage_bytes, updated_at)
           VALUES ($1, 1000000, 0, now())
           ON CONFLICT (organization_id) DO UPDATE SET used_storage_bytes = 0`,
          [org],
        ),
      );
    }

    orgBResourceId = await tenantContext.run(contextFor(ORG_B), () =>
      tenantDataSource.transaction(async (manager) => {
        const created = await resourceRepo.create(
          { name: 'org-b-secret.pdf', description: null, sizeBytes: 100, createdBy: USER_A },
          manager,
        );
        return created.id;
      }),
    );
  });

  it('a genuinely-scoped read runs first, on this same pool, before the cross-tenant probe below', async () => {
    // Establishes that this pool's connections have already served a scoped
    // transaction BEFORE the assertions below run — the exact precondition
    // that made the probe throw before the RLS policy fix.
    const own = await tenantContext.run(contextFor(ORG_B), () => service.getById(orgBResourceId));
    expect(own.id).toBe(orgBResourceId);
  });

  it('org A reading org B\'s resource by id gets a clean 404, not a 500, on a reused connection', async () => {
    await expect(
      tenantContext.run(contextFor(ORG_A), () => service.getById(orgBResourceId)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('the same cross-tenant attempt DOES publish CrossTenantAccessAttempted — detection actually fires', async () => {
    await expect(
      tenantContext.run(contextFor(ORG_A), () => service.getById(orgBResourceId)),
    ).rejects.toMatchObject({ status: 404 });

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0].eventType).toBe('CrossTenantAccessAttempted');
    expect(publishedEvents[0].payload).toMatchObject({
      subjectType: 'Resource',
      subjectId: orgBResourceId,
      actorOrganizationId: ORG_A,
    });
  });

  it('a genuinely nonexistent id gets the same 404 and publishes NOTHING', async () => {
    await expect(
      tenantContext.run(contextFor(ORG_A), () =>
        service.getById('99999999-9999-9999-9999-999999999999'),
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(publishedEvents).toHaveLength(0);
  });
});
