import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { contextStore } from '../../src/lib/context-store';
import * as events from '../../src/lib/events';
import { NotFoundException } from '../../src/lib/http-errors';
import * as tenantDb from '../../src/lib/tenant-db';
import * as users from '../../src/models/user.model';
import type { User } from '../../src/models/user.model';
import * as usersRead from '../../src/services/users-read.service';
import { Role } from '../../src/types/constants';
import { EVENT_TYPES, TOPICS } from '../../src/types/events';

jest.mock('../../src/lib/prisma', () => ({ getPrisma: () => ({}) }));
jest.mock('../../src/lib/events', () => ({ publish: jest.fn(), publishAll: jest.fn() }));
jest.mock('../../src/lib/tenant-db', () => ({
  transaction: jest.fn((work: (tx: unknown) => unknown) => Promise.resolve(work({}))),
  transactionForOrganization: jest.fn((_org: string, work: (tx: unknown) => unknown) =>
    Promise.resolve(work({})),
  ),
  runGlobal: jest.fn((work: (tx: unknown) => unknown) => Promise.resolve(work({}))),
}));
jest.mock('../../src/models/user.model', () => ({
  findById: jest.fn(),
  listPage: jest.fn(),
  existsInAnyOrganization: jest.fn(),
  findOrganizationIdForUser: jest.fn(),
  findNonRemovedRole: jest.fn(),
}));
jest.mock('../../src/models/invitation.model', () => ({ listPending: jest.fn() }));

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR_ID = '22222222-2222-2222-2222-222222222222';
const TARGET_ID = '33333333-3333-3333-3333-333333333333';

const usersMock = jest.mocked(users);
const publish = jest.mocked(events.publish);
const runGlobal = jest.mocked(tenantDb.runGlobal);

function makeUser(): User {
  return {
    id: TARGET_ID,
    organizationId: ORG_ID,
    email: 'someone@example.com',
    firstName: 'Some',
    lastName: 'One',
    role: 'org_member',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

function buildContext() {
  return {
    userId: ACTOR_ID,
    organizationId: ORG_ID,
    roles: [Role.ORG_ADMIN],
    correlationId: 'corr-1',
    iat: 0,
    exp: 0,
  };
}

const inOrg = <T>(fn: () => Promise<T>): Promise<T> => contextStore.run(buildContext(), fn);

function setup(deps: { found: User | null; existsElsewhere?: boolean }) {
  usersMock.findById.mockResolvedValue(deps.found);
  usersMock.existsInAnyOrganization.mockResolvedValue(deps.existsElsewhere ?? false);
}

async function captureError(run: () => Promise<unknown>): Promise<NotFoundException> {
  try {
    await run();
  } catch (err) {
    return err as NotFoundException;
  }
  throw new Error('expected getById to reject, but it resolved');
}

/**
 * getById 404s a foreign-tenant id (RLS makes that automatic) and publishes
 * CrossTenantAccessAttempted — while the caller still cannot tell the two 404s apart.
 */
describe('users-read.service — cross-tenant attempt detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    publish.mockResolvedValue(undefined);
  });

  it('returns the user and publishes nothing when RLS lets the row through', async () => {
    setup({ found: makeUser() });

    const result = await inOrg(() => usersRead.getById(TARGET_ID));

    expect(result.id).toBe(TARGET_ID);
    expect(usersMock.findById).toHaveBeenCalledWith(expect.anything(), ORG_ID, TARGET_ID);
    expect(publish).not.toHaveBeenCalled();
    // No probe at all on the happy path — it runs only after a miss.
    expect(runGlobal).not.toHaveBeenCalled();
  });

  it('404s AND publishes CrossTenantAccessAttempted when the id belongs to another org', async () => {
    setup({ found: null, existsElsewhere: true });

    await expect(inOrg(() => usersRead.getById(TARGET_ID))).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(publish).toHaveBeenCalledWith(
      TOPICS.SECURITY,
      expect.objectContaining({
        eventType: EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED,
        organizationId: ORG_ID,
        actorUserId: ACTOR_ID,
        payload: expect.objectContaining({
          subjectType: 'User',
          subjectId: TARGET_ID,
          actorOrganizationId: ORG_ID,
        }),
      }),
    );
  });

  it('404s with NO event when the id does not exist anywhere', async () => {
    setup({ found: null, existsElsewhere: false });

    await expect(inOrg(() => usersRead.getById(TARGET_ID))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('a failing probe does not change the 404', async () => {
    setup({ found: null });
    usersMock.existsInAnyOrganization.mockRejectedValue(new Error('db down'));

    const err = await captureError(() => inOrg(() => usersRead.getById(TARGET_ID)));
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it('gives the caller an identical 404 in both cases — no existence oracle', async () => {
    setup({ found: null, existsElsewhere: true });
    const foreignErr = await captureError(() => inOrg(() => usersRead.getById(TARGET_ID)));
    setup({ found: null, existsElsewhere: false });
    const missingErr = await captureError(() => inOrg(() => usersRead.getById(TARGET_ID)));

    expect(foreignErr.status).toBe(404);
    expect(missingErr.status).toBe(404);
    expect(foreignErr.getBody()).toEqual(missingErr.getBody());
    expect(foreignErr.getBody()).toEqual({ message: 'Not Found', statusCode: 404 });
  });

  it('never carries the OWNING organisation id in the security event', async () => {
    setup({ found: null, existsElsewhere: true });

    await expect(inOrg(() => usersRead.getById(TARGET_ID))).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const [, event] = publish.mock.calls[0] as [string, { payload: Record<string, unknown> }];
    const orgIds = Object.entries(event.payload)
      .filter(([key]) => key.toLowerCase().includes('organization'))
      .map(([, value]) => value);
    expect(orgIds.every((id) => id === ORG_ID)).toBe(true);
  });
});

describe('users-read.service — getRoleForAuthService / listPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns { role: null } when the user belongs to no organisation', async () => {
    usersMock.findOrganizationIdForUser.mockResolvedValue(null);
    await expect(usersRead.getRoleForAuthService(TARGET_ID)).resolves.toEqual({ role: null });
    expect(usersMock.findNonRemovedRole).not.toHaveBeenCalled();
  });

  it('reads the role scoped to the org the SECURITY DEFINER lookup resolved', async () => {
    usersMock.findOrganizationIdForUser.mockResolvedValue(ORG_ID);
    usersMock.findNonRemovedRole.mockResolvedValue('org_admin');

    await expect(usersRead.getRoleForAuthService(TARGET_ID)).resolves.toEqual({
      role: 'org_admin',
    });
    expect(tenantDb.transactionForOrganization).toHaveBeenCalledWith(ORG_ID, expect.any(Function));
  });

  it('listPage maps users to the response shape', async () => {
    usersMock.listPage.mockResolvedValue({ items: [makeUser()], hasMore: false, nextCursor: null });

    const page = await inOrg(() => usersRead.listPage({ limit: 5 }));

    expect(usersMock.listPage).toHaveBeenCalledWith(expect.anything(), ORG_ID, { limit: 5 });
    expect(page).toEqual({
      items: [
        {
          id: TARGET_ID,
          email: 'someone@example.com',
          firstName: 'Some',
          lastName: 'One',
          role: 'org_member',
          status: 'active',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
  });
});
