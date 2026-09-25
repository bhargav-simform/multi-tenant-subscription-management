import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  ConflictException,
  GoneException,
  HttpException,
  LastAdminException,
  NotFoundException,
} from '../../src/lib/http-errors';
import { contextStore } from '../../src/lib/context-store';
import { sha256Hex } from '../../src/lib/hashing';
import * as events from '../../src/lib/events';
import * as tenantDb from '../../src/lib/tenant-db';
import * as invitations from '../../src/models/invitation.model';
import type { Invitation } from '../../src/models/invitation.model';
import * as seats from '../../src/models/subscription-seat.model';
import * as users from '../../src/models/user.model';
import type { User } from '../../src/models/user.model';
import * as credentials from '../../src/services/credentials.service';
import * as usersService from '../../src/services/users.service';
import { Role } from '../../src/types/constants';
import { EVENT_TYPES } from '../../src/types/events';

jest.mock('../../src/lib/prisma', () => ({ getPrisma: () => ({}) }));
jest.mock('../../src/lib/events', () => ({ publish: jest.fn(), publishAll: jest.fn() }));
jest.mock('../../src/services/credentials.service', () => ({ createCredentials: jest.fn() }));
jest.mock('../../src/models/subscription-seat.model', () => ({
  lockForUpdate: jest.fn(),
  adjustUsedSeats: jest.fn(),
  listOrganizationIds: jest.fn(),
}));
jest.mock('../../src/models/user.model', () => ({
  findById: jest.fn(),
  countActive: jest.fn(),
  countActiveAdmins: jest.fn(),
  create: jest.fn(),
  markRemoved: jest.fn(),
  updateRole: jest.fn(),
}));
jest.mock('../../src/models/invitation.model', () => ({
  ...jest.requireActual<typeof import('../../src/models/invitation.model')>(
    '../../src/models/invitation.model',
  ),
  countPending: jest.fn(),
  create: jest.fn(),
  findPendingByTokenHashForUpdate: jest.fn(),
  markAccepted: jest.fn(),
  findById: jest.fn(),
  markRevoked: jest.fn(),
  findOrganizationIdByTokenHash: jest.fn(),
}));

/**
 * A fake tenant-db whose transactions serialise exactly like a real row lock: a
 * second transaction is deferred until the first fully resolves (commit or
 * rollback). It serialises unconditionally, so these tests prove the transaction's
 * SHAPE — check under the lock, write in the same transaction, the rejection
 * message, event order — not that FOR UPDATE is actually taken. That is the
 * integration test's job.
 */
jest.mock('../../src/lib/tenant-db', () => {
  let queue: Promise<unknown> = Promise.resolve();
  const serialised = <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
    const run = queue.then(() => work({}));
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    transaction: jest.fn(serialised),
    transactionForOrganization: jest.fn((_org: string, work: (tx: unknown) => Promise<unknown>) =>
      serialised(work),
    ),
    transactionWithDeferredScope: jest.fn(
      (work: (tx: unknown, scope: (org: string) => Promise<void>) => Promise<unknown>) =>
        serialised((tx) => work(tx, async () => undefined)),
    ),
    runGlobal: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({})),
  };
});

const ORG_ID = 'org-1';

const usersMock = jest.mocked(users);
const invitationsMock = jest.mocked(invitations);
const seatsMock = jest.mocked(seats);
const createCredentials = jest.mocked(credentials.createCredentials);
const publish = jest.mocked(events.publish);

/** In-memory seat row — the actual invariant under test. */
const seatRow = { usedSeats: 0, maxSeatsSnapshot: 5 };

function buildContext() {
  return {
    userId: 'admin-1',
    organizationId: ORG_ID,
    roles: [Role.ORG_ADMIN],
    correlationId: 'corr-1',
    iat: 0,
    exp: 0,
  };
}

/** The rejection of a promise that must reject. */
async function rejectionOf<E = HttpException>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (err) {
    return err as E;
  }
  throw new Error('expected a rejection, but the promise resolved');
}

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> => contextStore.run(buildContext(), fn);

function pendingInvitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: 'invitation-1',
    organizationId: ORG_ID,
    email: 'invitee@acme.test',
    role: 'org_member',
    tokenHash: 'hash',
    expiresAt: new Date(Date.now() + 100000),
    acceptedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function activeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    organizationId: ORG_ID,
    email: 'member@acme.test',
    firstName: 'M',
    lastName: 'B',
    role: 'org_member',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

describe('users.service', () => {
  let activeUsers: number;
  let pendingInvitations: number;
  /** Fakes get_invitation_organization_id(token_hash). */
  let invitationOrgIdByTokenHash: Map<string, string>;

  beforeEach(() => {
    jest.clearAllMocks();
    seatRow.usedSeats = 0;
    seatRow.maxSeatsSnapshot = 5;
    activeUsers = 0;
    pendingInvitations = 0;
    invitationOrgIdByTokenHash = new Map();

    seatsMock.lockForUpdate.mockImplementation(async () => ({ ...seatRow }));
    seatsMock.adjustUsedSeats.mockImplementation(async (_tx, _org, delta) => {
      seatRow.usedSeats += delta;
    });

    usersMock.findById.mockResolvedValue(null);
    usersMock.countActive.mockImplementation(async () => activeUsers);
    usersMock.countActiveAdmins.mockResolvedValue(1);
    usersMock.create.mockImplementation(async (_tx, data) => {
      activeUsers += 1;
      return activeUser({
        id: data.id ?? `user-${Math.random()}`,
        email: data.email,
        role: data.role,
      });
    });
    usersMock.markRemoved.mockResolvedValue(undefined);
    usersMock.updateRole.mockResolvedValue(undefined);

    invitationsMock.countPending.mockImplementation(async () => pendingInvitations);
    invitationsMock.create.mockImplementation(async (_tx, _org, data) => {
      pendingInvitations += 1;
      return pendingInvitation({ id: `invitation-${Math.random()}`, email: data.email });
    });
    invitationsMock.findPendingByTokenHashForUpdate.mockResolvedValue(null);
    invitationsMock.markAccepted.mockResolvedValue(undefined);
    invitationsMock.findById.mockResolvedValue(null);
    invitationsMock.markRevoked.mockResolvedValue(undefined);
    invitationsMock.findOrganizationIdByTokenHash.mockImplementation(
      async (_tx, tokenHash) => invitationOrgIdByTokenHash.get(tokenHash) ?? null,
    );

    createCredentials.mockResolvedValue({ userId: 'minted-user-id' });
    publish.mockResolvedValue(undefined);
  });

  it('transaction SHAPE: two concurrent invites, 1 seat free — exactly one succeeds', async () => {
    seatRow.usedSeats = 4;
    seatRow.maxSeatsSnapshot = 5;

    const invite = (email: string) =>
      asAdmin(() => usersService.invite({ email, role: 'org_member' }));
    const results = await Promise.allSettled([invite('a@acme.test'), invite('b@acme.test')]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as HttpException).getBody(),
    ).toMatchObject({
      error: 'PLAN_LIMIT_EXCEEDED',
    });
    // used_seats never exceeds the limit and reflects exactly one successful invite.
    expect(seatRow.usedSeats).toBe(5);
  });

  it('transaction SHAPE: 50 concurrent invites, 2 seats free — exactly 2 succeed', async () => {
    seatRow.usedSeats = 3;
    seatRow.maxSeatsSnapshot = 5;

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        asAdmin(() => usersService.invite({ email: `user${i}@acme.test`, role: 'org_member' })),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(seatRow.usedSeats).toBe(5);
  });

  it('rejects with a SPECIFIC message including the seat breakdown, not a generic error', async () => {
    seatRow.usedSeats = 5;
    seatRow.maxSeatsSnapshot = 5;

    const err = await rejectionOf(
      asAdmin(() => usersService.invite({ email: 'x@acme.test', role: 'org_member' })),
    );
    expect(err.getBody()).toMatchObject({
      statusCode: 409,
      error: 'PLAN_LIMIT_EXCEEDED',
      details: expect.objectContaining({ limitType: 'seats', limit: 5, current: 5 }),
      message: expect.stringContaining('5 seats'),
    });
  });

  it('a pending invitation holds a seat', async () => {
    seatRow.maxSeatsSnapshot = 1;

    const first = await asAdmin(() =>
      usersService.invite({ email: 'first@acme.test', role: 'org_member' }),
    );
    expect(seatRow.usedSeats).toBe(1);
    expect(first.tokenForDev).toHaveLength(72);
    expect(invitationsMock.create).toHaveBeenCalledWith(
      expect.anything(),
      ORG_ID,
      expect.objectContaining({
        email: 'first@acme.test',
        tokenHash: sha256Hex(first.tokenForDev),
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      'user.events',
      expect.objectContaining({ eventType: EVENT_TYPES.USER_INVITED, actorUserId: 'admin-1' }),
    );

    // A second invite, before the first is accepted, must be refused.
    await expect(
      asAdmin(() => usersService.invite({ email: 'second@acme.test', role: 'org_member' })),
    ).rejects.toMatchObject({ status: 409 });
    expect(seatRow.usedSeats).toBe(1);
  });

  it('a duplicate pending invitation is a plain 409 Conflict and takes no seat', async () => {
    invitationsMock.create.mockRejectedValueOnce(
      new invitations.InvitationAlreadyPendingError('dup@acme.test'),
    );

    const err = await rejectionOf(
      asAdmin(() => usersService.invite({ email: 'dup@acme.test', role: 'org_member' })),
    );
    expect(err.getBody()).toEqual({
      message: 'An invitation for "dup@acme.test" is already pending in this organization',
      error: 'Conflict',
      statusCode: 409,
    });
    expect(seatRow.usedSeats).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('revoking an invitation releases its seat', async () => {
    seatRow.maxSeatsSnapshot = 1;
    const { invitationId } = await asAdmin(() =>
      usersService.invite({ email: 'first@acme.test', role: 'org_member' }),
    );
    expect(seatRow.usedSeats).toBe(1);

    invitationsMock.findById.mockResolvedValue(pendingInvitation({ id: invitationId }));
    await asAdmin(() => usersService.revokeInvitation(invitationId));

    expect(seatRow.usedSeats).toBe(0);
    expect(publish).toHaveBeenLastCalledWith(
      'user.events',
      expect.objectContaining({
        eventType: EVENT_TYPES.INVITATION_REVOKED,
        payload: { invitationId },
      }),
    );
  });

  it('revoking an already-revoked invitation is a 404', async () => {
    invitationsMock.findById.mockResolvedValue(pendingInvitation({ revokedAt: new Date() }));
    await expect(
      asAdmin(() => usersService.revokeInvitation('invitation-1')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(seatsMock.adjustUsedSeats).not.toHaveBeenCalled();
  });

  it('acceptInvitation is net-zero on used_seats — the seat was already held', async () => {
    seatRow.usedSeats = 1;
    invitationOrgIdByTokenHash.set(sha256Hex('raw-token'), ORG_ID);
    invitationsMock.findPendingByTokenHashForUpdate.mockResolvedValue(pendingInvitation());

    const result = await usersService.acceptInvitation('raw-token', {
      firstName: 'New',
      lastName: 'Hire',
      password: 'a-long-enough-password',
    });

    expect(result.email).toBe('invitee@acme.test');
    // The credential's userId is the users row's id.
    expect(createCredentials).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      email: 'invitee@acme.test',
      password: 'a-long-enough-password',
    });
    expect(invitationsMock.markAccepted).toHaveBeenCalledWith(expect.anything(), 'invitation-1');
    expect(usersMock.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'minted-user-id',
        organizationId: ORG_ID,
        email: 'invitee@acme.test',
      }),
    );
    expect(seatRow.usedSeats).toBe(1);
    expect(seatsMock.adjustUsedSeats).not.toHaveBeenCalled();
    expect(seatsMock.lockForUpdate).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      'user.events',
      expect.objectContaining({ eventType: EVENT_TYPES.USER_CREATED }),
    );
    expect(publish).toHaveBeenCalledWith(
      'user.events',
      expect.objectContaining({ eventType: EVENT_TYPES.INVITATION_ACCEPTED }),
    );
  });

  it('acceptInvitation creates the credential outside any transaction', async () => {
    invitationOrgIdByTokenHash.set(sha256Hex('raw-token'), ORG_ID);
    invitationsMock.findPendingByTokenHashForUpdate.mockResolvedValue(pendingInvitation());
    const txDeferred = jest.mocked(tenantDb.transactionWithDeferredScope);
    createCredentials.mockImplementation(async () => {
      expect(txDeferred).not.toHaveBeenCalled();
      return { userId: 'minted-user-id' };
    });

    await usersService.acceptInvitation('raw-token', {
      firstName: 'A',
      lastName: 'B',
      password: 'a-long-enough-password',
    });
    expect(txDeferred).toHaveBeenCalledTimes(1);
  });

  it('a credential failure (e.g. email already registered) surfaces as a plain 500 error', async () => {
    invitationOrgIdByTokenHash.set(sha256Hex('raw-token'), ORG_ID);
    invitationsMock.findPendingByTokenHashForUpdate.mockResolvedValue(pendingInvitation());
    createCredentials.mockRejectedValue(new ConflictException('Email already registered'));

    const err = await rejectionOf<Error>(
      usersService.acceptInvitation('raw-token', {
        firstName: 'A',
        lastName: 'B',
        password: 'a-long-enough-password',
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toHaveProperty('status');
    expect(usersMock.create).not.toHaveBeenCalled();
  });

  it('throws GoneException (410) for an unknown or already-used invitation token', async () => {
    await expect(
      usersService.acceptInvitation('garbage-token', {
        firstName: 'A',
        lastName: 'B',
        password: 'a-long-enough-password',
      }),
    ).rejects.toBeInstanceOf(GoneException);
    expect(createCredentials).not.toHaveBeenCalled();
  });

  it('throws GoneException for an invitation whose token resolves but has expired', async () => {
    invitationOrgIdByTokenHash.set(sha256Hex('raw-token'), ORG_ID);
    invitationsMock.findPendingByTokenHashForUpdate.mockResolvedValue(
      pendingInvitation({ expiresAt: new Date(Date.now() - 1000) }),
    );

    const err = await rejectionOf<GoneException>(
      usersService.acceptInvitation('raw-token', {
        firstName: 'A',
        lastName: 'B',
        password: 'a-long-enough-password',
      }),
    );
    expect(err).toBeInstanceOf(GoneException);
    expect(err.getBody()).toEqual({
      message: 'This invitation has expired or already been used.',
      error: 'Gone',
      statusCode: 410,
    });
    expect(createCredentials).not.toHaveBeenCalled();
  });

  describe('updateRole / removeUser', () => {
    it('updateRole throws NotFoundException when the user does not exist', async () => {
      await expect(
        asAdmin(() => usersService.updateRole('missing-user', 'org_member')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updateRole blocks demoting the last remaining admin', async () => {
      usersMock.findById.mockResolvedValue(activeUser({ role: 'org_admin' }));
      usersMock.countActiveAdmins.mockResolvedValue(1);

      await expect(
        asAdmin(() => usersService.updateRole('user-1', 'org_member')),
      ).rejects.toBeInstanceOf(LastAdminException);
      expect(usersMock.updateRole).not.toHaveBeenCalled();
    });

    it('updateRole allows demoting an admin when another admin remains', async () => {
      usersMock.findById.mockResolvedValue(activeUser({ role: 'org_admin' }));
      usersMock.countActiveAdmins.mockResolvedValue(2);

      const result = await asAdmin(() => usersService.updateRole('user-1', 'org_member'));

      expect(usersMock.updateRole).toHaveBeenCalledWith(
        expect.anything(),
        ORG_ID,
        'user-1',
        'org_member',
      );
      expect(result.id).toBe('user-1');
      expect(publish).toHaveBeenCalledWith(
        'user.events',
        expect.objectContaining({
          eventType: EVENT_TYPES.USER_ROLE_CHANGED,
          payload: { userId: 'user-1', role: 'org_member' },
        }),
      );
    });

    it('removeUser throws NotFoundException for an already-removed user', async () => {
      usersMock.findById.mockResolvedValue(activeUser({ status: 'removed' }));

      await expect(asAdmin(() => usersService.removeUser('user-1'))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('removeUser blocks removing the last remaining admin', async () => {
      usersMock.findById.mockResolvedValue(activeUser({ role: 'org_admin' }));
      usersMock.countActiveAdmins.mockResolvedValue(1);

      await expect(asAdmin(() => usersService.removeUser('user-1'))).rejects.toBeInstanceOf(
        LastAdminException,
      );
      expect(usersMock.markRemoved).not.toHaveBeenCalled();
    });

    it('removeUser frees a seat when removing a non-last-admin user', async () => {
      seatRow.usedSeats = 1;
      usersMock.findById.mockResolvedValue(activeUser());

      await asAdmin(() => usersService.removeUser('user-1'));

      expect(usersMock.markRemoved).toHaveBeenCalledWith(expect.anything(), ORG_ID, 'user-1');
      expect(seatRow.usedSeats).toBe(0);
    });
  });
});
