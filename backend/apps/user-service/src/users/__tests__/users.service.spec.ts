import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { GoneException } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { EventPublisher } from '@app/kafka';
import { EVENT_TYPES, Role } from '@app/common';
import { UsersService } from '../users.service';
import { USER_REPOSITORY } from '../user.repository.interface';
import { INVITATION_REPOSITORY } from '../../invitations/invitation.repository.interface';
import { SUBSCRIPTION_SEAT_REPOSITORY } from '../../subscriptions/subscription-seat.repository.interface';
import { UserRole } from '../user.entity';
import type { User } from '../user.entity';
import type { Invitation } from '../../invitations/invitation.entity';
import type { SeatSnapshot } from '../../subscriptions/subscription-seat.repository.interface';

const ORG_ID = 'org-1';

/**
 * §19: proves the seat-limit transaction's SHAPE — lock first, check under
 * the lock, write in the same transaction, correct rejection message,
 * correct event ordering. `SerializingFakeDataSource` below serialises
 * EVERY call unconditionally, regardless of whether the production code
 * actually takes a lock — so this file's "concurrent" tests cannot detect a
 * missing `FOR UPDATE`; they can only detect a wrong CHECK, a wrong message,
 * or a wrong call order. Confirmed by deliberately removing
 * `SubscriptionSeatRepository`'s `.setLock('pessimistic_write')` and
 * observing these tests still pass while the real integration test below
 * fails — see test/integration/user-service/seat-lock.integration.spec.ts,
 * §28.1, which is the actual T3 proof, run against real PostgreSQL through
 * Testcontainers, using the same non-superuser app_user role production
 * runs as. `pnpm test:integration` runs it; `pnpm test` (this file) does not.
 */
describe('UsersService', () => {
  /**
   * A fake TenantAwareDataSource whose `transaction()` serialises callbacks
   * exactly like a real Postgres row lock: a second call is DEFERRED until
   * the first fully resolves, and it observes only the FIRST call's fully
   * committed state — this is the property FOR UPDATE guarantees and the
   * property this test suite exists to exercise. It is not a mock of
   * "call this and return X"; it is a working (if crude) lock.
   */
  class SerializingFakeDataSource {
    private queue: Promise<unknown> = Promise.resolve();

    async transaction<T>(work: (manager: unknown) => Promise<T>): Promise<T> {
      const run = this.queue.then(() => work({}));
      // Chain the next caller behind this one, regardless of success/failure —
      // a real row lock releases on rollback too.
      this.queue = run.catch(() => undefined);
      return run;
    }

    async runGlobal<T>(work: (manager: unknown) => Promise<T>): Promise<T> {
      return work({});
    }

    async transactionForOrganization<T>(
      _organizationId: string,
      work: (manager: unknown) => Promise<T>,
    ): Promise<T> {
      return this.transaction(work);
    }

    async transactionWithDeferredScope<T>(
      work: (manager: unknown, setScope: (organizationId: string) => Promise<void>) => Promise<T>,
    ): Promise<T> {
      return this.transaction((manager) => work(manager, async () => undefined));
    }
  }

  /** In-memory seat repository — the actual invariant under test. */
  class FakeSeatRepository {
    usedSeats = 0;
    maxSeatsSnapshot = 5;

    async lockForUpdate(): Promise<SeatSnapshot> {
      return { usedSeats: this.usedSeats, maxSeatsSnapshot: this.maxSeatsSnapshot };
    }

    async adjustUsedSeats(_organizationId: string, delta: number): Promise<void> {
      this.usedSeats += delta;
    }
  }

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

  async function buildService(seatRepo: FakeSeatRepository) {
    const dataSource = new SerializingFakeDataSource();
    const tenantContext = new TenantContextStore();

    const activeUsersByOrg = new Map<string, number>([[ORG_ID, 0]]);
    const pendingInvitationsByOrg = new Map<string, number>([[ORG_ID, 0]]);

    const users = {
      findById: jest.fn<() => Promise<User | null>>().mockResolvedValue(null),
      countActive: jest
        .fn<(organizationId: string) => Promise<number>>()
        .mockImplementation(async (organizationId) => activeUsersByOrg.get(organizationId) ?? 0),
      countActiveAdmins: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      create: jest
        .fn<(data: { email: string; organizationId: string }, manager: unknown) => Promise<User>>()
        .mockImplementation(async (data) => {
          activeUsersByOrg.set(ORG_ID, (activeUsersByOrg.get(ORG_ID) ?? 0) + 1);
          return {
            id: `user-${Math.random()}`,
            organizationId: data.organizationId,
            email: data.email,
            firstName: 'A',
            lastName: 'B',
            role: UserRole.ORG_MEMBER,
            status: 'active',
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          } as User;
        }),
      markRemoved: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      updateRole: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      listPage: jest.fn(),
      findRoleByUserId: jest.fn<() => Promise<UserRole | null>>().mockResolvedValue(null),
    };

    const invitations = {
      countPending: jest
        .fn<(organizationId: string) => Promise<number>>()
        .mockImplementation(async (organizationId) => pendingInvitationsByOrg.get(organizationId) ?? 0),
      create: jest
        .fn<(data: { email: string }) => Promise<Invitation>>()
        .mockImplementation(async (data) => {
          pendingInvitationsByOrg.set(ORG_ID, (pendingInvitationsByOrg.get(ORG_ID) ?? 0) + 1);
          return { id: `invitation-${Math.random()}`, email: data.email } as Invitation;
        }),
      findPendingByTokenHashForUpdate: jest
        .fn<(tokenHash: string, manager: unknown) => Promise<Invitation | null>>()
        .mockResolvedValue(null),
      markAccepted: jest.fn<(id: string, manager: unknown) => Promise<void>>().mockResolvedValue(undefined),
      findById: jest.fn<() => Promise<Invitation | null>>().mockResolvedValue(null),
      markRevoked: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      findExpiredIds: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      markManyExpired: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const publisher = {
      publish: jest.fn<(topic: string, event: unknown) => Promise<void>>().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: TenantAwareDataSource, useValue: dataSource },
        { provide: TenantContextStore, useValue: tenantContext },
        { provide: EventPublisher, useValue: publisher },
        { provide: USER_REPOSITORY, useValue: users },
        { provide: INVITATION_REPOSITORY, useValue: invitations },
        { provide: SUBSCRIPTION_SEAT_REPOSITORY, useValue: seatRepo },
      ],
    }).compile();

    return { service: moduleRef.get(UsersService), tenantContext, users, invitations, publisher };
  }

  it('transaction SHAPE (not a lock proof — see file header): two invites via the serialising fake, 1 seat free — exactly one succeeds', async () => {
    const seatRepo = new FakeSeatRepository();
    seatRepo.usedSeats = 4;
    seatRepo.maxSeatsSnapshot = 5;
    const { service, tenantContext } = await buildService(seatRepo);

    const invite = (email: string) =>
      tenantContext.run(buildContext(), () =>
        service.invite({ email, role: UserRole.ORG_MEMBER }),
      );

    const results = await Promise.allSettled([invite('a@acme.test'), invite('b@acme.test')]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      response: expect.objectContaining({ error: 'PLAN_LIMIT_EXCEEDED' }),
    });
    // The invariant: used_seats never exceeds the limit, and reflects
    // EXACTLY one successful invite, not zero and not two.
    expect(seatRepo.usedSeats).toBe(5);
  });

  it('transaction SHAPE (not a lock proof): 50 invites via the serialising fake, 2 seats free — exactly 2 succeed', async () => {
    const seatRepo = new FakeSeatRepository();
    seatRepo.usedSeats = 3;
    seatRepo.maxSeatsSnapshot = 5;
    const { service, tenantContext } = await buildService(seatRepo);

    const invite = (i: number) =>
      tenantContext.run(buildContext(), () =>
        service.invite({ email: `user${i}@acme.test`, role: UserRole.ORG_MEMBER }),
      );

    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => invite(i)));
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    expect(fulfilled).toHaveLength(2);
    expect(seatRepo.usedSeats).toBe(5);
  });

  it('rejects with a SPECIFIC message including the seat breakdown, not a generic error', async () => {
    const seatRepo = new FakeSeatRepository();
    seatRepo.usedSeats = 5;
    seatRepo.maxSeatsSnapshot = 5;
    const { service, tenantContext } = await buildService(seatRepo);

    await expect(
      tenantContext.run(buildContext(), () =>
        service.invite({ email: 'x@acme.test', role: UserRole.ORG_MEMBER }),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: 'PLAN_LIMIT_EXCEEDED',
        details: expect.objectContaining({ limitType: 'seats', limit: 5, current: 5 }),
        message: expect.stringContaining('5 seats'),
      }),
    });
  });

  it('a pending invitation holds a seat — the invariant D-Q1 depends on', async () => {
    const seatRepo = new FakeSeatRepository();
    seatRepo.usedSeats = 0;
    seatRepo.maxSeatsSnapshot = 1;
    const { service, tenantContext } = await buildService(seatRepo);

    await tenantContext.run(buildContext(), () =>
      service.invite({ email: 'first@acme.test', role: UserRole.ORG_MEMBER }),
    );
    expect(seatRepo.usedSeats).toBe(1);

    // A second invite, before the first is ever accepted, must be refused —
    // proving the PENDING invitation itself holds the seat.
    await expect(
      tenantContext.run(buildContext(), () =>
        service.invite({ email: 'second@acme.test', role: UserRole.ORG_MEMBER }),
      ),
    ).rejects.toMatchObject({ response: expect.objectContaining({ error: 'PLAN_LIMIT_EXCEEDED' }) });
  });

  it('revoking an invitation releases its seat', async () => {
    const seatRepo = new FakeSeatRepository();
    seatRepo.usedSeats = 0;
    seatRepo.maxSeatsSnapshot = 1;
    const { service, tenantContext, invitations } = await buildService(seatRepo);

    const { invitationId } = await tenantContext.run(buildContext(), () =>
      service.invite({ email: 'first@acme.test', role: UserRole.ORG_MEMBER }),
    );
    expect(seatRepo.usedSeats).toBe(1);

    invitations.findById.mockResolvedValue({
      id: invitationId,
      acceptedAt: null,
      revokedAt: null,
    } as Invitation);

    await tenantContext.run(buildContext(), () => service.revokeInvitation(invitationId));

    expect(seatRepo.usedSeats).toBe(0);
  });

  it('acceptInvitation is net-zero on used_seats — the seat was already held (§19.8)', async () => {
    const seatRepo = new FakeSeatRepository();
    seatRepo.usedSeats = 1; // one seat already held by the pending invitation
    seatRepo.maxSeatsSnapshot = 5;
    const { service, invitations, users, publisher } = await buildService(seatRepo);

    invitations.findPendingByTokenHashForUpdate.mockResolvedValue({
      id: 'invitation-1',
      organizationId: ORG_ID,
      email: 'invitee@acme.test',
      role: UserRole.ORG_MEMBER,
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 100000),
      acceptedAt: null,
      revokedAt: null,
    } as Invitation);

    const result = await service.acceptInvitation('raw-token', {
      firstName: 'New',
      lastName: 'Hire',
    });

    expect(result.email).toBe('invitee@acme.test');
    expect(invitations.markAccepted).toHaveBeenCalledWith('invitation-1', expect.anything());
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG_ID, email: 'invitee@acme.test' }),
      expect.anything(),
    );
    // The invariant this test exists to prove: used_seats is UNCHANGED.
    // adjustUsedSeats must never have been called by acceptance.
    expect(seatRepo.usedSeats).toBe(1);
    expect(publisher.publish).toHaveBeenCalledWith(
      'user.events',
      expect.objectContaining({ eventType: EVENT_TYPES.USER_CREATED }),
    );
    expect(publisher.publish).toHaveBeenCalledWith(
      'user.events',
      expect.objectContaining({ eventType: EVENT_TYPES.INVITATION_ACCEPTED }),
    );
  });

  it('throws GoneException (410) for an unknown or already-used invitation token', async () => {
    const seatRepo = new FakeSeatRepository();
    const { service, invitations } = await buildService(seatRepo);
    invitations.findPendingByTokenHashForUpdate.mockResolvedValue(null);

    await expect(
      service.acceptInvitation('garbage-token', { firstName: 'A', lastName: 'B' }),
    ).rejects.toBeInstanceOf(GoneException);
  });

  it('throws GoneException for an invitation whose token resolves but has expired', async () => {
    const seatRepo = new FakeSeatRepository();
    const { service, invitations } = await buildService(seatRepo);
    invitations.findPendingByTokenHashForUpdate.mockResolvedValue({
      id: 'invitation-1',
      organizationId: ORG_ID,
      email: 'invitee@acme.test',
      role: UserRole.ORG_MEMBER,
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() - 1000), // already expired
      acceptedAt: null,
      revokedAt: null,
    } as Invitation);

    await expect(
      service.acceptInvitation('raw-token', { firstName: 'A', lastName: 'B' }),
    ).rejects.toBeInstanceOf(GoneException);
  });
});
