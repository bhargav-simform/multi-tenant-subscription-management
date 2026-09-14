import { jest, describe, it, expect } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '@app/redis';
import { EventPublisher } from '@app/kafka';
import { EVENT_TYPES } from '@app/common';
import { OnboardingService } from '../onboarding.service';
import { ORGANIZATION_REPOSITORY } from '../../organizations/organization.repository.interface';
import { ONBOARDING_SAGA_REPOSITORY } from '../onboarding-saga.repository';
import { OrganizationSlugTakenError } from '../../organizations/organization-slug-taken.error';
import { AUTH_CLIENT } from '../auth-client.interface';
import { SUBSCRIPTION_CLIENT } from '../subscription-client.interface';
import { SagaState, type OnboardingSaga } from '../onboarding-saga.entity';
import { OrganizationStatus, type Organization } from '../../organizations/organization.entity';
import type { SignupDto } from '../dto/signup.dto';

type OrgRepoMock = {
  findById: jest.Mock<() => Promise<Organization | null>>;
  create: jest.Mock<() => Promise<Organization>>;
  updateStatus: jest.Mock<(id: string, status: OrganizationStatus, manager?: unknown) => Promise<void>>;
  listPage: jest.Mock;
};

type SagaRepoMock = {
  findByIdempotencyKey: jest.Mock<() => Promise<OnboardingSaga | null>>;
  create: jest.Mock<() => Promise<OnboardingSaga>>;
  advance: jest.Mock<
    (
      id: string,
      state: SagaState,
      patch: Record<string, unknown>,
      manager: unknown,
    ) => Promise<void>
  >;
  markFailed: jest.Mock<(id: string, error: string, manager: unknown) => Promise<void>>;
};

/**
 * §30.1: proves the forward-recovery saga resumes from wherever it stopped —
 * including from a RECORDED FAILURE, never re-running a completed step, never
 * creating duplicate data, and never losing the resume point on error.
 */
describe('OnboardingService', () => {
  const dto: SignupDto = {
    organizationName: 'Acme Inc',
    adminEmail: 'admin@acme.test',
    adminPassword: 'super-secret-password',
    adminFirstName: 'Ada',
    adminLastName: 'Admin',
    idempotencyKey: 'test-key-00000001',
  };

  function makeSaga(overrides: Partial<OnboardingSaga> = {}): OnboardingSaga {
    return {
      id: 'saga-1',
      idempotencyKey: dto.idempotencyKey,
      organizationId: null,
      state: SagaState.PENDING,
      adminEmail: dto.adminEmail,
      lastError: null,
      failedAt: null,
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function makeOrg(overrides: Partial<Organization> = {}): Organization {
    return {
      id: 'org-1',
      name: dto.organizationName,
      slug: 'acme-inc',
      status: OrganizationStatus.PROVISIONING,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function makeClients(overrides: {
    createCredentials?: jest.Mock<() => Promise<{ userId: string }>>;
    assignDefaultPlan?: jest.Mock<() => Promise<{ subscriptionId: string }>>;
  } = {}) {
    return {
      authClient: {
        createCredentials:
          overrides.createCredentials ??
          jest.fn<() => Promise<{ userId: string }>>().mockResolvedValue({ userId: 'u1' }),
      },
      subscriptionClient: {
        assignDefaultPlan:
          overrides.assignDefaultPlan ??
          jest
            .fn<() => Promise<{ subscriptionId: string }>>()
            .mockResolvedValue({ subscriptionId: 's1' }),
      },
    };
  }

  async function buildService(deps: {
    saga: OnboardingSaga | null;
    org: Organization;
    authClient: { createCredentials: jest.Mock<() => Promise<{ userId: string }>> };
    subscriptionClient: {
      assignDefaultPlan: jest.Mock<() => Promise<{ subscriptionId: string }>>;
    };
  }) {
    const organizations: OrgRepoMock = {
      findById: jest.fn<() => Promise<Organization | null>>().mockResolvedValue(deps.org),
      create: jest.fn<() => Promise<Organization>>().mockResolvedValue(deps.org),
      updateStatus: jest.fn<(id: string, status: OrganizationStatus, manager?: unknown) => Promise<void>>().mockResolvedValue(undefined),
      listPage: jest.fn(),
    };
    const sagas: SagaRepoMock = {
      findByIdempotencyKey: jest
        .fn<() => Promise<OnboardingSaga | null>>()
        .mockResolvedValue(deps.saga),
      create: jest.fn<() => Promise<OnboardingSaga>>().mockResolvedValue(makeSaga()),
      advance: jest
        .fn<
          (
            id: string,
            state: SagaState,
            patch: Record<string, unknown>,
            manager: unknown,
          ) => Promise<void>
        >()
        .mockResolvedValue(undefined),
      markFailed: jest
        .fn<(id: string, error: string, manager: unknown) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) => work({})),
    };
    const idempotency = { claim: jest.fn<() => Promise<boolean>>().mockResolvedValue(true) };
    const publisher = {
      publish: jest
        .fn<(topic: string, event: { eventType: string }) => Promise<void>>()
        .mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: DataSource, useValue: dataSource },
        { provide: IdempotencyService, useValue: idempotency },
        { provide: EventPublisher, useValue: publisher },
        { provide: ORGANIZATION_REPOSITORY, useValue: organizations },
        { provide: ONBOARDING_SAGA_REPOSITORY, useValue: sagas },
        { provide: AUTH_CLIENT, useValue: deps.authClient },
        { provide: SUBSCRIPTION_CLIENT, useValue: deps.subscriptionClient },
      ],
    }).compile();

    return {
      service: moduleRef.get(OnboardingService),
      organizations,
      sagas,
      publisher,
    };
  }

  it('runs all steps for a brand-new signup and publishes both onboarding events', async () => {
    const org = makeOrg({ status: OrganizationStatus.ACTIVE });
    const { authClient, subscriptionClient } = makeClients();
    const { service, sagas, publisher } = await buildService({
      saga: null,
      org,
      authClient,
      subscriptionClient,
    });

    const result = await service.signup(dto);

    expect(result.organizationId).toBe(org.id);
    expect(authClient.createCredentials).toHaveBeenCalledTimes(1);
    expect(subscriptionClient.assignDefaultPlan).toHaveBeenCalledTimes(1);
    expect(sagas.advance).toHaveBeenLastCalledWith(
      'saga-1',
      SagaState.COMPLETE,
      {},
      expect.anything(),
    );
    // §26.3: onboarding leaves a structured trace — the ORDER matters, so this
    // checks both event types were published, not merely "something" was.
    const publishedTypes = publisher.publish.mock.calls.map(
      (call) => (call[1] as { eventType: string }).eventType,
    );
    expect(publishedTypes).toEqual([
      EVENT_TYPES.ORGANIZATION_CREATED,
      EVENT_TYPES.ORGANIZATION_PROVISIONED,
    ]);
  });

  it('RESUMES from ORG_CREATED without re-creating the organisation (§30.1)', async () => {
    const org = makeOrg();
    const existingSaga = makeSaga({ state: SagaState.ORG_CREATED, organizationId: org.id });
    const { authClient, subscriptionClient } = makeClients();
    const { service, organizations } = await buildService({
      saga: existingSaga,
      org,
      authClient,
      subscriptionClient,
    });

    await service.signup(dto);

    expect(organizations.create).not.toHaveBeenCalled();
    expect(authClient.createCredentials).toHaveBeenCalledTimes(1);
    expect(subscriptionClient.assignDefaultPlan).toHaveBeenCalledTimes(1);
  });

  it('RESUMES from a RECORDED FAILURE at CREDENTIALS_CREATED — the exact case §30.1 exists for', async () => {
    // The saga previously failed while assigning the default plan. Its state
    // was NOT overwritten to a "failed" value (onboarding-saga.entity.ts) — it
    // still reads CREDENTIALS_CREATED, with failedAt/lastError set alongside.
    const org = makeOrg();
    const failedSaga = makeSaga({
      state: SagaState.CREDENTIALS_CREATED,
      organizationId: org.id,
      failedAt: new Date('2026-01-01T00:00:00Z'),
      lastError: 'subscription-service unreachable',
    });
    const { authClient, subscriptionClient } = makeClients();
    const { service, organizations } = await buildService({
      saga: failedSaga,
      org,
      authClient,
      subscriptionClient,
    });

    const result = await service.signup(dto);

    // Neither organisation creation nor credential creation runs again.
    expect(organizations.create).not.toHaveBeenCalled();
    expect(authClient.createCredentials).not.toHaveBeenCalled();
    // Only the step after the recorded failure point runs.
    expect(subscriptionClient.assignDefaultPlan).toHaveBeenCalledTimes(1);
    expect(result.organizationId).toBe(org.id);
  });

  it('returns the existing result for an already-COMPLETE saga without re-running anything', async () => {
    const org = makeOrg({ status: OrganizationStatus.ACTIVE });
    const completedSaga = makeSaga({ state: SagaState.COMPLETE, organizationId: org.id });
    const { authClient, subscriptionClient } = makeClients();
    authClient.createCredentials = jest.fn<() => Promise<{ userId: string }>>();
    subscriptionClient.assignDefaultPlan = jest.fn<() => Promise<{ subscriptionId: string }>>();
    const { service } = await buildService({
      saga: completedSaga,
      org,
      authClient,
      subscriptionClient,
    });

    const result = await service.signup(dto);

    expect(result.organizationId).toBe(org.id);
    expect(authClient.createCredentials).not.toHaveBeenCalled();
    expect(subscriptionClient.assignDefaultPlan).not.toHaveBeenCalled();
  });

  it('records the failure WITHOUT advancing state, marks the org provisioning_failed, and returns 409 not 500', async () => {
    const org = makeOrg();
    const failingAuthClient = {
      createCredentials: jest
        .fn<() => Promise<{ userId: string }>>()
        .mockRejectedValue(new Error('auth-service unreachable')),
    };
    const { subscriptionClient } = makeClients();
    const { service, sagas, organizations } = await buildService({
      saga: null,
      org,
      authClient: failingAuthClient,
      subscriptionClient,
    });

    await expect(service.signup(dto)).rejects.toMatchObject({
      response: { error: 'ONBOARDING_INCOMPLETE' },
    });

    // Organisation creation succeeds first (advance() records ORG_CREATED —
    // the true last-good-state), THEN credential creation fails. The failure
    // path uses markFailed(), which never receives or writes a "state"
    // argument at all — this is the assertion that would have caught the
    // original bug (a "FAILED" pseudo-state overwriting the resume point).
    expect(sagas.advance).toHaveBeenCalledTimes(1);
    expect(sagas.advance).toHaveBeenCalledWith(
      'saga-1',
      SagaState.ORG_CREATED,
      { organizationId: org.id },
      expect.anything(),
    );
    expect(sagas.markFailed).toHaveBeenCalledWith(
      'saga-1',
      expect.stringContaining('auth-service unreachable'),
      expect.anything(),
    );
    // §30.1: "the org becomes provisioning_failed".
    expect(organizations.updateStatus).toHaveBeenCalledWith(
      org.id,
      OrganizationStatus.PROVISIONING_FAILED,
      expect.anything(),
    );
  });

  it('does not mark the saga failed on a slug conflict — it is a naming conflict, not a saga failure', async () => {
    const org = makeOrg();
    const conflictingOrganizations: OrgRepoMock = {
      findById: jest.fn<() => Promise<Organization | null>>().mockResolvedValue(org),
      create: jest
        .fn<() => Promise<Organization>>()
        .mockRejectedValue(new OrganizationSlugTakenError('acme-inc')),
      updateStatus: jest.fn<(id: string, status: OrganizationStatus, manager?: unknown) => Promise<void>>().mockResolvedValue(undefined),
      listPage: jest.fn(),
    };
    const sagas: SagaRepoMock = {
      findByIdempotencyKey: jest.fn<() => Promise<OnboardingSaga | null>>().mockResolvedValue(null),
      create: jest.fn<() => Promise<OnboardingSaga>>().mockResolvedValue(makeSaga()),
      advance: jest
        .fn<
          (
            id: string,
            state: SagaState,
            patch: Record<string, unknown>,
            manager: unknown,
          ) => Promise<void>
        >()
        .mockResolvedValue(undefined),
      markFailed: jest
        .fn<(id: string, error: string, manager: unknown) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) => work({})),
    };
    const { authClient, subscriptionClient } = makeClients();

    const moduleRef = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: DataSource, useValue: dataSource },
        { provide: IdempotencyService, useValue: { claim: jest.fn<() => Promise<boolean>>().mockResolvedValue(true) } },
        { provide: EventPublisher, useValue: { publish: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) } },
        { provide: ORGANIZATION_REPOSITORY, useValue: conflictingOrganizations },
        { provide: ONBOARDING_SAGA_REPOSITORY, useValue: sagas },
        { provide: AUTH_CLIENT, useValue: authClient },
        { provide: SUBSCRIPTION_CLIENT, useValue: subscriptionClient },
      ],
    }).compile();
    const service = moduleRef.get(OnboardingService);

    await expect(service.signup(dto)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ message: expect.stringContaining('already taken') }),
    });

    expect(sagas.markFailed).not.toHaveBeenCalled();
  });
});
