import { randomUUID } from 'node:crypto';
import { resetThrottleState } from '../../src/middlewares/throttle';
import {
  API,
  HttpHarness,
  bearer,
  type OrgAdminSession,
  type Session,
} from '../support/http-harness';

const NOT_FOUND = { message: 'Not Found', statusCode: 404 };
const FREE_STORAGE = 5_368_709_120;

/** /resources/*: the storage-limit path, ownership rules and T1 for resources. */
describe('HTTP contract: resources', () => {
  const h = new HttpHarness();
  let orgA: OrgAdminSession;
  let orgB: OrgAdminSession;
  let memberA: Session;
  let orgBResourceId: string;

  beforeAll(async () => {
    await h.start();
    orgA = await h.signup();
    orgB = await h.signup();
    memberA = await h.addMember(orgA);
    orgBResourceId = (
      await h
        .http()
        .post(`${API}/resources`)
        .set(bearer(orgB))
        .send({ name: 'org-b-secret.pdf', description: 'B only', sizeBytes: 10 })
    ).body.id;
  });
  afterAll(() => h.stop());
  beforeEach(() => resetThrottleState());

  const create = (session: Session, body: Record<string, unknown>) =>
    h.http().post(`${API}/resources`).set(bearer(session)).send(body);

  async function crossTenantEvents(subjectId: string) {
    return h.superuserQuery<{ organization_id: string; payload: Record<string, unknown> }>(
      `SELECT organization_id, payload FROM security_events
        WHERE event_type = 'CrossTenantAccessAttempted' AND payload->>'subjectId' = $1`,
      [subjectId],
    );
  }

  describe('POST /resources', () => {
    it('201 with the resource — createdBy from the token, no organizationId in the body', async () => {
      const res = await create(memberA, {
        name: 'report.pdf',
        description: 'Q3',
        sizeBytes: 1_024,
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        name: 'report.pdf',
        description: 'Q3',
        sizeBytes: 1_024,
        createdBy: memberA.userId,
        createdAt: expect.any(String),
      });
    });

    it('updates the locked counter and (via the event) the subscription display counter', async () => {
      const org = await h.signup();
      await create(org, { name: 'a', sizeBytes: 3_000 });
      const [cache] = await h.superuserQuery(
        `SELECT used_storage_bytes::int AS used FROM plan_limit_cache WHERE organization_id = $1`,
        [org.organizationId],
      );
      expect(cache).toEqual({ used: 3_000 });
      const sub = await h.http().get(`${API}/subscriptions/current`).set(bearer(org));
      expect(sub.body.usedStorageBytes).toBe(3_000);
    });

    it('409 PLAN_LIMIT_EXCEEDED when the resource does not fit the storage limit', async () => {
      const org = await h.signup();
      await create(org, { name: 'big', sizeBytes: 5_000_000_000 });
      const res = await create(org, { name: 'too-big', sizeBytes: 1_000_000_000 });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        statusCode: 409,
        error: 'PLAN_LIMIT_EXCEEDED',
        message:
          'This resource needs 953.7 MB, but only 351.6 MB of your 5.0 GB storage limit remains ' +
          '(4.7 GB in use). Delete an existing resource or upgrade your plan to add more.',
        details: {
          limitType: 'storage',
          limit: FREE_STORAGE,
          current: 5_000_000_000,
          planCode: 'unknown',
        },
      });
    });

    it('503 (fail closed) when the org has no storage limit synced yet', async () => {
      const org = await h.signup();
      await h.superuserQuery(`DELETE FROM plan_limit_cache WHERE organization_id = $1`, [
        org.organizationId,
      ]);
      const res = await create(org, { name: 'early', sizeBytes: 1 });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        message:
          "Your plan's storage limit is not available yet — this organisation's subscription " +
          'details are still being synchronised. Please retry in a few seconds.',
        error: 'Service Unavailable',
        statusCode: 503,
      });
    });

    it('400: wrong types, non-integer size, smuggled organizationId/createdBy', async () => {
      const res = await create(orgA, {
        name: 1,
        sizeBytes: 1.5,
        organizationId: orgB.organizationId,
        createdBy: orgB.userId,
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: [
          'property organizationId should not exist',
          'property createdBy should not exist',
          'name must be shorter than or equal to 255 characters',
          'name must be a string',
          'sizeBytes must be an integer number',
        ],
        error: 'Bad Request',
        statusCode: 400,
      });

      const numericString = await create(orgA, { name: 'x', sizeBytes: '10' });
      expect(numericString.body.message).toEqual([
        'sizeBytes must not be less than 0',
        'sizeBytes must be an integer number',
      ]);
      const negative = await create(orgA, { name: 'x', sizeBytes: -1 });
      expect(negative.body.message).toEqual(['sizeBytes must not be less than 0']);
    });
  });

  describe('GET /resources', () => {
    let org: OrgAdminSession;

    beforeAll(async () => {
      org = await h.signup();
      await create(org, { name: 'small', description: 'has one', sizeBytes: 10 });
      await create(org, { name: 'large', sizeBytes: 1_000 });
      await create(org, { name: 'medium', description: '', sizeBytes: 100 });
    });

    it("200 keyset page of the caller's org only, newest first", async () => {
      const res = await h.http().get(`${API}/resources`).set(bearer(org));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: expect.any(Array), nextCursor: null, hasMore: false });
      expect(res.body.items.map((r: { name: string }) => r.name)).toEqual([
        'medium',
        'large',
        'small',
      ]);
      expect(res.text).not.toContain('org-b-secret');
    });

    it('sort=sizeBytes orders by size, and its cursor pages correctly', async () => {
      const first = await h.http().get(`${API}/resources?sort=sizeBytes&limit=2`).set(bearer(org));
      expect(first.body.items.map((r: { name: string }) => r.name)).toEqual(['large', 'medium']);
      expect(first.body.hasMore).toBe(true);

      const next = await h
        .http()
        .get(`${API}/resources?sort=sizeBytes&limit=2&cursor=${first.body.nextCursor}`)
        .set(bearer(org));
      expect(next.body).toMatchObject({ hasMore: false, nextCursor: null });
      expect(next.body.items.map((r: { name: string }) => r.name)).toEqual(['small']);
    });

    it('hasDescription filters server-side (empty string counts as none)', async () => {
      const withDesc = await h.http().get(`${API}/resources?hasDescription=true`).set(bearer(org));
      expect(withDesc.body.items.map((r: { name: string }) => r.name)).toEqual(['small']);
      const without = await h.http().get(`${API}/resources?hasDescription=false`).set(bearer(org));
      expect(without.body.items.map((r: { name: string }) => r.name)).toEqual(['medium', 'large']);
    });

    it('400 for invalid sort / limit / hasDescription', async () => {
      const res = await h
        .http()
        .get(`${API}/resources?sort=name&limit=0&hasDescription=maybe`)
        .set(bearer(org));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: [
          'limit must not be less than 1',
          'sort must be one of the following values: createdAt, sizeBytes',
          'hasDescription must be a boolean string',
        ],
        error: 'Bad Request',
        statusCode: 400,
      });
    });
  });

  describe('GET /resources/:id (T1)', () => {
    it("200 for the caller's own resource", async () => {
      const { body } = await create(orgA, { name: 'mine.pdf', sizeBytes: 5 });
      const res = await h.http().get(`${API}/resources/${body.id}`).set(bearer(memberA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual(body);
    });

    it("404 (not 403) for another org's resource, no trace of it, and a CrossTenantAccessAttempted event", async () => {
      const res = await h.http().get(`${API}/resources/${orgBResourceId}`).set(bearer(orgA));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(res.text).not.toContain('org-b-secret');

      const events = await crossTenantEvents(orgBResourceId);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        organization_id: orgA.organizationId,
        payload: {
          subjectType: 'Resource',
          subjectId: orgBResourceId,
          actorOrganizationId: orgA.organizationId,
          actorUserId: orgA.userId,
        },
      });
    });

    it('a missing id is the identical 404 with no event', async () => {
      const missing = randomUUID();
      const res = await h.http().get(`${API}/resources/${missing}`).set(bearer(orgA));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(await crossTenantEvents(missing)).toEqual([]);
    });

    it('400 for a malformed id (ParseUUIDPipe semantics)', async () => {
      const res = await h.http().get(`${API}/resources/not-a-uuid`).set(bearer(orgA));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        message: 'Validation failed (uuid is expected)',
        error: 'Bad Request',
        statusCode: 400,
      });
    });
  });

  describe('DELETE /resources/:id', () => {
    it('204 for a member deleting their own; the storage is released', async () => {
      const { body } = await create(memberA, { name: 'temp', sizeBytes: 700 });
      const [before] = await h.superuserQuery<{ used: number }>(
        `SELECT used_storage_bytes::int AS used FROM plan_limit_cache WHERE organization_id = $1`,
        [orgA.organizationId],
      );
      const res = await h.http().delete(`${API}/resources/${body.id}`).set(bearer(memberA));
      expect(res.status).toBe(204);
      expect(res.text).toBe('');

      const [after] = await h.superuserQuery<{ used: number }>(
        `SELECT used_storage_bytes::int AS used FROM plan_limit_cache WHERE organization_id = $1`,
        [orgA.organizationId],
      );
      expect(after.used).toBe(before.used - 700);
      expect((await h.http().get(`${API}/resources/${body.id}`).set(bearer(memberA))).status).toBe(
        404,
      );
    });

    it("403 for a member deleting someone else's resource; an admin may delete any in the org", async () => {
      const { body } = await create(orgA, { name: 'admins', sizeBytes: 1 });
      const asMember = await h.http().delete(`${API}/resources/${body.id}`).set(bearer(memberA));
      expect(asMember.status).toBe(403);
      expect(asMember.body).toEqual({
        message: 'You may only modify resources you created',
        error: 'Forbidden',
        statusCode: 403,
      });

      const { body: membersOwn } = await create(memberA, { name: 'members', sizeBytes: 1 });
      expect(
        (await h.http().delete(`${API}/resources/${membersOwn.id}`).set(bearer(orgA))).status,
      ).toBe(204);
    });

    it("404 for another org's resource, which survives, plus a security event", async () => {
      const before = (await crossTenantEvents(orgBResourceId)).length;
      const res = await h.http().delete(`${API}/resources/${orgBResourceId}`).set(bearer(orgA));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(await crossTenantEvents(orgBResourceId)).toHaveLength(before + 1);
      expect(
        (await h.http().get(`${API}/resources/${orgBResourceId}`).set(bearer(orgB))).status,
      ).toBe(200);
    });

    it('400 for a malformed id', async () => {
      const res = await h.http().delete(`${API}/resources/nope`).set(bearer(orgA));
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Validation failed (uuid is expected)');
    });
  });
});
