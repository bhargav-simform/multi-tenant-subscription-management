import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { resetThrottleState } from '../../src/middlewares/throttle';
import {
  API,
  HttpHarness,
  PASSWORD,
  bearer,
  type OrgAdminSession,
  type Session,
} from '../support/http-harness';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}

/**
 * Every 'METHOD /api/v1/path' registered on the app. Walks the router stacks, so a
 * route added later without a sweep entry below fails this suite.
 */
function registeredRoutes(app: Express): string[] {
  const out: string[] = [];
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          out.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
        }
      } else if (layer.handle?.stack) {
        // apiRouter is the only router mounted at a path; the feature routers are use()d at '/'.
        walk(layer.handle.stack, prefix || API);
      }
    }
  };
  walk((app as unknown as { router: { stack: Layer[] } }).router.stack, '');
  return out.sort();
}

/**
 * T4 — a platform admin cannot see tenant content. Seeds one org with content, then
 * sweeps EVERY registered route as a platform admin and asserts the documented status
 * and that no response carries any of the seeded content — not a resource name, not a
 * user's email or name, not an audit payload. An admin route that merely *happens* to
 * expose content is a failure even if the UI never links to it.
 *
 * Statuses are the ones the old stack produced (parity quirks included: /dashboard is
 * 403 via the users half, /subscriptions/current is a 500, /organizations/me a 404).
 */
describe('HTTP contract: platform admin sees metadata only — full route sweep (T4)', () => {
  const h = new HttpHarness();
  let org: OrgAdminSession;
  let member: Session;
  let platformAdmin: Session;
  let resourceId: string;
  let invitationId: string;

  const CONTENT = {
    resourceName: `quarterly-secret-${randomUUID().slice(0, 6)}.pdf`,
    resourceDescription: `board minutes ${randomUUID().slice(0, 6)}`,
    memberFirstName: `Zelda${randomUUID().slice(0, 6)}`,
    invitedEmail: `invitee-${randomUUID().slice(0, 8)}@example.com`,
  };

  beforeAll(async () => {
    await h.start();
    org = await h.signup();
    member = await h.addMember(org, 'org_member', CONTENT.memberFirstName);
    resourceId = (
      await h.http().post(`${API}/resources`).set(bearer(org)).send({
        name: CONTENT.resourceName,
        description: CONTENT.resourceDescription,
        sizeBytes: 42,
      })
    ).body.id;
    invitationId = (
      await h
        .http()
        .post(`${API}/users/invite`)
        .set(bearer(org))
        .send({ email: CONTENT.invitedEmail, role: 'org_member' })
    ).body.invitationId;
    platformAdmin = await h.createPlatformAdmin();
  });
  afterAll(() => h.stop());
  beforeEach(() => resetThrottleState());

  /** Everything that must never appear in a platform-admin response. */
  const forbiddenStrings = () => [
    CONTENT.resourceName,
    CONTENT.resourceDescription,
    CONTENT.memberFirstName,
    CONTENT.invitedEmail,
    member.email,
    org.email,
  ];

  const forbidden = (message: string) => ({ message, error: 'Forbidden', statusCode: 403 });
  const INTERNAL = { statusCode: 500, message: 'Internal server error' };

  interface SweepCase {
    route: string;
    call: () => ReturnType<ReturnType<HttpHarness['http']>['get']>;
    status: number;
    body?: unknown;
  }

  const cases = (): SweepCase[] => {
    const as = <T extends { set: (h: { Authorization: string }) => T }>(req: T) =>
      req.set(bearer(platformAdmin));
    const http = () => h.http();
    return [
      { route: 'GET /api/v1/health', call: () => http().get(`${API}/health`), status: 200 },
      {
        route: 'GET /api/v1/health/ready',
        call: () => http().get(`${API}/health/ready`),
        status: 200,
      },
      {
        route: 'POST /api/v1/auth/login',
        call: () =>
          http().post(`${API}/auth/login`).send({ email: platformAdmin.email, password: PASSWORD }),
        status: 200,
      },
      {
        route: 'POST /api/v1/auth/refresh',
        call: () =>
          http().post(`${API}/auth/refresh`).send({ refreshToken: platformAdmin.refreshToken }),
        status: 200,
      },
      {
        route: 'POST /api/v1/onboarding/signup',
        call: () => http().post(`${API}/onboarding/signup`).send({}),
        status: 400,
      },
      {
        route: 'GET /api/v1/invitations',
        call: () => as(http().get(`${API}/invitations`)),
        status: 403,
        body: forbidden('You do not have permission to read User'),
      },
      {
        route: 'POST /api/v1/invitations/:token/accept',
        call: () =>
          http()
            .post(`${API}/invitations/${randomUUID()}/accept`)
            .send({ firstName: 'P', lastName: 'A', password: PASSWORD }),
        status: 410,
      },
      {
        route: 'DELETE /api/v1/invitations/:id',
        call: () => as(http().delete(`${API}/invitations/${invitationId}`)),
        status: 403,
        body: forbidden('You do not have permission to delete User'),
      },
      {
        route: 'GET /api/v1/organizations/me',
        call: () => as(http().get(`${API}/organizations/me`)),
        status: 404,
        body: { message: 'Not Found', statusCode: 404 },
      },
      {
        route: 'GET /api/v1/organizations',
        call: () => as(http().get(`${API}/organizations`)),
        status: 200,
      },
      {
        route: 'GET /api/v1/organizations/:id',
        call: () => as(http().get(`${API}/organizations/${org.organizationId}`)),
        status: 200,
      },
      {
        route: 'POST /api/v1/users/invite',
        call: () =>
          as(http().post(`${API}/users/invite`)).send({
            email: 'pa@example.com',
            role: 'org_member',
          }),
        status: 403,
        body: forbidden('You do not have permission to create User'),
      },
      {
        route: 'GET /api/v1/users',
        call: () => as(http().get(`${API}/users`)),
        status: 403,
        body: forbidden('You do not have permission to read User'),
      },
      {
        route: 'GET /api/v1/users/:id',
        call: () => as(http().get(`${API}/users/${member.userId}`)),
        status: 403,
        body: forbidden('You do not have permission to read User'),
      },
      {
        route: 'PATCH /api/v1/users/:id/role',
        call: () =>
          as(http().patch(`${API}/users/${member.userId}/role`)).send({ role: 'org_admin' }),
        status: 403,
        body: forbidden('You do not have permission to update User'),
      },
      {
        route: 'DELETE /api/v1/users/:id',
        call: () => as(http().delete(`${API}/users/${member.userId}`)),
        status: 403,
        body: forbidden('You do not have permission to delete User'),
      },
      { route: 'GET /api/v1/plans', call: () => as(http().get(`${API}/plans`)), status: 200 },
      {
        route: 'GET /api/v1/subscriptions/current',
        call: () => as(http().get(`${API}/subscriptions/current`)),
        status: 500,
        body: INTERNAL,
      },
      {
        route: 'POST /api/v1/subscriptions/change',
        call: () => as(http().post(`${API}/subscriptions/change`)).send({ planCode: 'pro' }),
        status: 403,
        body: forbidden('You do not have permission to update Subscription'),
      },
      { route: 'GET /api/v1/usage', call: () => as(http().get(`${API}/usage`)), status: 200 },
      {
        route: 'POST /api/v1/resources',
        call: () => as(http().post(`${API}/resources`)).send({ name: 'x', sizeBytes: 1 }),
        status: 403,
        body: forbidden('You do not have permission to create Resource'),
      },
      {
        route: 'GET /api/v1/resources',
        call: () => as(http().get(`${API}/resources`)),
        status: 403,
        body: forbidden('You do not have permission to read Resource'),
      },
      // A KNOWN resource id: CASL refuses before the lookup, so nothing about it is revealed.
      {
        route: 'GET /api/v1/resources/:id',
        call: () => as(http().get(`${API}/resources/${resourceId}`)),
        status: 403,
        body: forbidden('You do not have permission to read Resource'),
      },
      {
        route: 'DELETE /api/v1/resources/:id',
        call: () => as(http().delete(`${API}/resources/${resourceId}`)),
        status: 403,
        body: forbidden('You do not have permission to delete Resource'),
      },
      { route: 'GET /api/v1/audit', call: () => as(http().get(`${API}/audit`)), status: 200 },
      {
        route: 'GET /api/v1/audit/security',
        call: () => as(http().get(`${API}/audit/security`)),
        status: 200,
      },
      {
        route: 'GET /api/v1/dashboard',
        call: () => as(http().get(`${API}/dashboard`)),
        status: 403,
        body: forbidden('You do not have permission to read User'),
      },
      // Last: it kills the sweep's access token.
      {
        route: 'POST /api/v1/auth/logout',
        call: () => as(http().post(`${API}/auth/logout`)).send({ refreshToken: 'unknown' }),
        status: 204,
      },
    ];
  };

  it('the sweep covers exactly the registered routes (a new route must be added here)', () => {
    expect(
      cases()
        .map((c) => c.route)
        .sort(),
    ).toEqual(registeredRoutes(h.app));
  });

  it('every route returns its documented status and never a byte of tenant content', async () => {
    const seen: string[] = [];
    for (const c of cases()) {
      const res = await c.call();
      seen.push(`${c.route} -> ${res.status}`);
      expect({ route: c.route, status: res.status }).toEqual({ route: c.route, status: c.status });
      if (c.body !== undefined) expect(res.body).toEqual(c.body);
      for (const s of forbiddenStrings()) {
        expect({ route: c.route, leaked: res.text.includes(s) ? s : null }).toEqual({
          route: c.route,
          leaked: null,
        });
      }
    }
    expect(seen).toHaveLength(cases().length);
  });

  it('every non-public route answers 401 {message:"Unauthorized"} without a token', async () => {
    const PUBLIC = new Set([
      'GET /api/v1/health',
      'GET /api/v1/health/ready',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/refresh',
      'POST /api/v1/onboarding/signup',
      'POST /api/v1/invitations/:token/accept',
    ]);
    const routes = registeredRoutes(h.app).filter((r) => !PUBLIC.has(r));
    expect(routes.length).toBe(22);
    for (const route of routes) {
      const [method, path] = route.split(' ');
      const url = path.replace(/:[a-z]+/g, randomUUID());
      const agent = h.http() as unknown as Record<
        string,
        (u: string) => Promise<{ status: number; body: unknown }>
      >;
      const res = await agent[method.toLowerCase()](url);
      expect({ route, status: res.status, body: res.body }).toEqual({
        route,
        status: 401,
        body: { message: 'Unauthorized', statusCode: 401 },
      });
    }
  });

  describe('the 200 routes return metadata or integers only', () => {
    let session: Session;
    beforeAll(async () => {
      session = await h.login(platformAdmin.email, PASSWORD);
    });

    it('GET /organizations — id, name, slug, status and nothing else', async () => {
      const res = await h.http().get(`${API}/organizations?limit=100`).set(bearer(session));
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const item of res.body.items)
        expect(Object.keys(item).sort()).toEqual(['id', 'name', 'slug', 'status']);
    });

    it('GET /usage — integers per organisation, no content fields', async () => {
      const res = await h.http().get(`${API}/usage`).set(bearer(session));
      const row = res.body.find(
        (r: { organizationId: string }) => r.organizationId === org.organizationId,
      );
      expect(row).toEqual({
        organizationId: org.organizationId,
        planCode: 'free',
        usedSeats: 2,
        maxSeats: 5,
        usedStorageBytes: 42,
        maxStorageBytes: 5_368_709_120,
      });
    });

    it('GET /audit — the tenant trail is invisible (NULL-org rows only), and no payloads at all', async () => {
      const orgRows = await h.superuserQuery(
        `SELECT 1 FROM audit_events WHERE organization_id = $1`,
        [org.organizationId],
      );
      expect(orgRows.length).toBeGreaterThan(0);

      const res = await h.http().get(`${API}/audit?limit=100`).set(bearer(session));
      for (const item of res.body.items) {
        expect(item.organizationId).toBeNull();
        expect(item).not.toHaveProperty('payload');
      }
    });

    it('GET /audit/security — only NULL-org events; the cross-tenant attempt inside the org stays hidden', async () => {
      // An org-scoped security event exists...
      const other = await h.signup();
      await h.http().get(`${API}/resources/${resourceId}`).set(bearer(other));
      const orgScoped = await h.superuserQuery(
        `SELECT 1 FROM security_events WHERE organization_id = $1`,
        [other.organizationId],
      );
      expect(orgScoped).toHaveLength(1);

      // ...and the platform admin does not see it.
      const res = await h.http().get(`${API}/audit/security?limit=100`).set(bearer(session));
      expect(
        res.body.items.every((i: { organizationId: string | null }) => i.organizationId === null),
      ).toBe(true);
    });

    it('the platform admin token itself carries no organisation', async () => {
      const res = await h
        .http()
        .post(`${API}/auth/login`)
        .send({ email: platformAdmin.email, password: PASSWORD });
      expect(res.body.user).toEqual({
        id: expect.any(String),
        email: platformAdmin.email,
        roles: ['platform_admin'],
        organizationId: null,
      });
    });
  });
});
