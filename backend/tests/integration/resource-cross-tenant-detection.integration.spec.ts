import { clearSubscriptions } from '../../src/lib/events';
import { NotFoundException } from '../../src/lib/http-errors';
import { transactionForOrganization } from '../../src/lib/tenant-db';
import * as resources from '../../src/models/resource.model';
import * as resourcesService from '../../src/services/resources.service';
import { Role } from '../../src/types/constants';
import { EVENT_TYPES, TOPICS, type EventEnvelope } from '../../src/types/events';
import { PostgresTestContainer } from '../support/postgres-test-container';
import { recordEvents, runAs } from '../support/tenant-fixtures';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MISSING_ID = '99999999-9999-9999-9999-999999999999';

/**
 * T1 at the service level, on a REUSED pooled connection. getById's scoped read
 * finds nothing for a foreign id; its resource_exists() SECURITY DEFINER probe then
 * decides whether to publish CrossTenantAccessAttempted. Unit tests mock runGlobal(),
 * so they prove the probe is CALLED, never that it WORKS against FORCE RLS on a
 * connection that already served a scoped transaction — this suite does.
 */
describe('resources.service — cross-tenant detection on a reused connection (T1)', () => {
  const db = new PostgresTestContainer();
  let securityEvents: EventEnvelope[];
  let orgBResourceId: string;

  beforeAll(async () => {
    await db.start();
    securityEvents = recordEvents(TOPICS.SECURITY);
  });

  afterAll(async () => {
    clearSubscriptions();
    await db.stop();
  });

  beforeEach(async () => {
    securityEvents.length = 0;
    for (const org of [ORG_A, ORG_B]) {
      await transactionForOrganization(org, async (tx) => {
        await tx.$executeRaw`DELETE FROM resources`;
        await tx.$executeRaw`
          INSERT INTO plan_limit_cache (organization_id, max_storage_bytes, used_storage_bytes)
          VALUES (${org}::uuid, 1000000, 0)
          ON CONFLICT (organization_id) DO UPDATE SET used_storage_bytes = 0`;
      });
    }
    orgBResourceId = (
      await runAs(ORG_B, USER_B, () =>
        resourcesService.create({ name: 'org-b-secret.pdf', sizeBytes: 100 }),
      )
    ).id;
  });

  it('a genuinely-scoped read runs first on this same pool (the reuse precondition)', async () => {
    const own = await runAs(ORG_B, USER_B, () => resourcesService.getById(orgBResourceId));
    expect(own.id).toBe(orgBResourceId);
    expect(securityEvents).toHaveLength(0);
  });

  it("org A reading org B's resource by id gets a clean 404, not a 500", async () => {
    const err = await runAs(ORG_A, USER_A, () => resourcesService.getById(orgBResourceId)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).status).toBe(404);
    // No trace of the resource in the error body.
    expect(JSON.stringify((err as NotFoundException).getBody())).not.toContain('org-b-secret');
    expect((err as NotFoundException).getBody()).toEqual({ message: 'Not Found', statusCode: 404 });
  });

  it('the same attempt DOES publish CrossTenantAccessAttempted — detection actually fires', async () => {
    await expect(
      runAs(ORG_A, USER_A, () => resourcesService.getById(orgBResourceId)),
    ).rejects.toMatchObject({ status: 404 });

    expect(securityEvents).toHaveLength(1);
    expect(securityEvents[0].eventType).toBe(EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED);
    // The ACTOR's org, never the owner's.
    expect(securityEvents[0].organizationId).toBe(ORG_A);
    expect(securityEvents[0].payload).toEqual({
      subjectType: 'Resource',
      subjectId: orgBResourceId,
      actorOrganizationId: ORG_A,
      actorUserId: USER_A,
    });
  });

  it('DELETE of a foreign resource is the same 404 + event, and deletes nothing', async () => {
    await expect(
      runAs(ORG_A, USER_A, () => resourcesService.remove(orgBResourceId)),
    ).rejects.toMatchObject({ status: 404 });

    expect(securityEvents.map((e) => e.eventType)).toEqual([
      EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED,
    ]);
    const survived = await transactionForOrganization(ORG_B, (tx) =>
      resources.findById(tx, orgBResourceId, ORG_B),
    );
    expect(survived).not.toBeNull();
  });

  it('a genuinely nonexistent id gets the same 404 and publishes NOTHING', async () => {
    await expect(
      runAs(ORG_A, USER_A, () => resourcesService.getById(MISSING_ID)),
    ).rejects.toMatchObject({ status: 404 });
    expect(securityEvents).toHaveLength(0);
  });

  it('a soft-deleted resource in the same org is a 404 that still counts as "exists" to the probe', async () => {
    // resource_exists() deliberately does not filter deleted_at (see migration).
    await runAs(ORG_B, USER_B, () => resourcesService.remove(orgBResourceId));
    await expect(
      runAs(ORG_B, USER_B, () => resourcesService.getById(orgBResourceId)),
    ).rejects.toMatchObject({ status: 404 });
    expect(securityEvents).toHaveLength(1);
    expect(securityEvents[0].organizationId).toBe(ORG_B);
  });

  it('an org member hitting a foreign id gets the identical 404 + event', async () => {
    await expect(
      runAs(ORG_A, USER_A, () => resourcesService.getById(orgBResourceId), [Role.ORG_MEMBER]),
    ).rejects.toMatchObject({ status: 404 });
    expect(securityEvents).toHaveLength(1);
  });
});
