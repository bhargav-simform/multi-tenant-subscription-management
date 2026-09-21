import { jest, describe, it, expect } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { EventPublisher } from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS, Role } from '@app/common';
import { UsersReadService } from '../users-read.service';
import { USER_REPOSITORY } from '../user.repository.interface';
import { INVITATION_REPOSITORY } from '../../invitations/invitation.repository.interface';
import { UserRole, UserStatus, type User } from '../user.entity';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR_ID = '22222222-2222-2222-2222-222222222222';
const TARGET_ID = '33333333-3333-3333-3333-333333333333';

/**
 * §13.9, layer 4. getById has always returned 404 for a foreign-tenant id
 * (RLS makes that automatic), but it published no CrossTenantAccessAttempted
 * event, so the detector §13.9 describes had nothing to work with. These
 * tests cover that retrofit — and, just as importantly, that the caller still
 * cannot tell the two 404s apart.
 */
describe('UsersReadService — cross-tenant attempt detection (§13.9)', () => {
  function makeUser(): User {
    return {
      id: TARGET_ID,
      organizationId: ORG_ID,
      email: 'someone@example.com',
      firstName: 'Some',
      lastName: 'One',
      role: UserRole.ORG_MEMBER,
      status: UserStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as User;
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

  async function buildService(deps: { found: User | null; existsElsewhere?: boolean }) {
    const tenantContext = new TenantContextStore();

    const dataSource = {
      transaction: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) => work({})),
      runGlobal: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) =>
          work({
            query: jest
              .fn<() => Promise<unknown[]>>()
              .mockResolvedValue([{ user_exists: deps.existsElsewhere ?? false }]),
          }),
        ),
    };

    const users = {
      findById: jest
        .fn<(id: string, m: unknown) => Promise<User | null>>()
        .mockResolvedValue(deps.found),
      listPage: jest.fn<(q: unknown, m: unknown) => Promise<unknown>>().mockResolvedValue({
        items: [],
        hasMore: false,
        nextCursor: null,
      }),
      findRoleByUserId: jest.fn<(id: string) => Promise<string | null>>().mockResolvedValue(null),
      countActive: jest.fn<() => Promise<number>>().mockResolvedValue(0),
      countActiveAdmins: jest.fn<() => Promise<number>>().mockResolvedValue(0),
      create: jest.fn<() => Promise<User>>(),
      markRemoved: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      updateRole: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const publisher = {
      publish: jest
        .fn<(topic: string, event: unknown) => Promise<void>>()
        .mockResolvedValue(undefined),
    };

    const invitations = {
      countPending: jest.fn<() => Promise<number>>().mockResolvedValue(0),
      listPending: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
      create: jest.fn<() => Promise<unknown>>(),
      findPendingByTokenHashForUpdate: jest.fn<() => Promise<null>>().mockResolvedValue(null),
      markAccepted: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      findById: jest.fn<() => Promise<null>>().mockResolvedValue(null),
      markRevoked: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      findExpiredIds: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      markManyExpired: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersReadService,
        { provide: TenantAwareDataSource, useValue: dataSource },
        { provide: TenantContextStore, useValue: tenantContext },
        { provide: EventPublisher, useValue: publisher },
        { provide: USER_REPOSITORY, useValue: users },
        { provide: INVITATION_REPOSITORY, useValue: invitations },
      ],
    }).compile();

    return { service: moduleRef.get(UsersReadService), tenantContext, publisher, dataSource };
  }

  it('returns the user and publishes nothing when RLS lets the row through', async () => {
    const { service, tenantContext, publisher, dataSource } = await buildService({
      found: makeUser(),
    });

    const result = await tenantContext.run(buildContext(), () => service.getById(TARGET_ID));

    expect(result.id).toBe(TARGET_ID);
    expect(publisher.publish).not.toHaveBeenCalled();
    // No probe at all on the happy path — it runs only after a miss.
    expect(dataSource.runGlobal).not.toHaveBeenCalled();
  });

  it('404s AND publishes CrossTenantAccessAttempted when the id belongs to another org', async () => {
    const { service, tenantContext, publisher } = await buildService({
      found: null,
      existsElsewhere: true,
    });

    await expect(
      tenantContext.run(buildContext(), () => service.getById(TARGET_ID)),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(publisher.publish).toHaveBeenCalledWith(
      KAFKA_TOPICS.SECURITY,
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
    const { service, tenantContext, publisher } = await buildService({
      found: null,
      existsElsewhere: false,
    });

    await expect(
      tenantContext.run(buildContext(), () => service.getById(TARGET_ID)),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('gives the caller an identical 404 in both cases — no existence oracle (§13.9)', async () => {
    const foreign = await buildService({ found: null, existsElsewhere: true });
    const missing = await buildService({ found: null, existsElsewhere: false });

    async function captureError(run: () => Promise<unknown>): Promise<NotFoundException> {
      try {
        await run();
      } catch (err) {
        return err as NotFoundException;
      }
      throw new Error('expected getById to reject, but it resolved');
    }

    const foreignErr = await captureError(() =>
      foreign.tenantContext.run(buildContext(), () => foreign.service.getById(TARGET_ID)),
    );
    const missingErr = await captureError(() =>
      missing.tenantContext.run(buildContext(), () => missing.service.getById(TARGET_ID)),
    );

    expect(foreignErr.getStatus()).toBe(404);
    expect(missingErr.getStatus()).toBe(404);
    expect(foreignErr.getResponse()).toEqual(missingErr.getResponse());
  });

  it('never carries the OWNING organisation id in the security event', async () => {
    const { service, tenantContext, publisher } = await buildService({
      found: null,
      existsElsewhere: true,
    });

    await expect(
      tenantContext.run(buildContext(), () => service.getById(TARGET_ID)),
    ).rejects.toBeInstanceOf(NotFoundException);

    const [, event] = publisher.publish.mock.calls[0] as [
      string,
      { payload: Record<string, unknown>; organizationId: string | null },
    ];
    const orgIds = Object.entries(event.payload)
      .filter(([key]) => key.toLowerCase().includes('organization'))
      .map(([, value]) => value);
    expect(orgIds.every((id) => id === ORG_ID)).toBe(true);
  });
});
