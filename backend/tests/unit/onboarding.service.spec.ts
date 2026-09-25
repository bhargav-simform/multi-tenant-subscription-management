import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { SignupDto } from '../../src/dtos/onboarding.dto';
import * as events from '../../src/lib/events';
import { ConflictException } from '../../src/lib/http-errors';
import * as sagas from '../../src/models/onboarding-saga.model';
import { SagaState, type OnboardingSaga } from '../../src/models/onboarding-saga.model';
import * as organizations from '../../src/models/organization.model';
import { OrganizationSlugTakenError, type Organization } from '../../src/models/organization.model';
import * as credentialsService from '../../src/services/credentials.service';
import { signup } from '../../src/services/onboarding.service';
import * as subscriptions from '../../src/services/subscriptions.service';
import { EVENT_TYPES } from '../../src/types/events';

jest.mock('../../src/models/organization.model', () => ({
  ...jest.requireActual<typeof import('../../src/models/organization.model')>(
    '../../src/models/organization.model',
  ),
  findById: jest.fn(),
  findBySlug: jest.fn(),
  create: jest.fn(),
  updateStatus: jest.fn(),
  listPage: jest.fn(),
}));
jest.mock('../../src/models/onboarding-saga.model', () => ({
  ...jest.requireActual<typeof import('../../src/models/onboarding-saga.model')>(
    '../../src/models/onboarding-saga.model',
  ),
  findByIdempotencyKey: jest.fn(),
  create: jest.fn(),
  advance: jest.fn(),
  markFailed: jest.fn(),
}));
jest.mock('../../src/services/credentials.service', () => ({ createCredentials: jest.fn() }));
jest.mock('../../src/services/subscriptions.service', () => ({ assignDefaultPlan: jest.fn() }));
jest.mock('../../src/lib/events', () => ({ publish: jest.fn(), publishAll: jest.fn() }));
jest.mock('../../src/lib/prisma', () => ({ getPrisma: () => ({}) }));
jest.mock('../../src/lib/tenant-db', () => ({
  runGlobal: (work: (tx: unknown) => unknown) => Promise.resolve(work({})),
}));

const orgs = jest.mocked(organizations);
const sagaRepo = jest.mocked(sagas);
const createCredentials = jest.mocked(credentialsService.createCredentials);
const assignDefaultPlan = jest.mocked(subscriptions.assignDefaultPlan);
const publish = jest.mocked(events.publish);

/**
 * The forward-recovery saga resumes from wherever it stopped — including from a
 * RECORDED FAILURE — never re-running a completed step and never losing the resume
 * point on error.
 */
describe('onboarding.service', () => {
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
      adminUserId: null,
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
      status: 'provisioning',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function given(deps: { saga: OnboardingSaga | null; org: Organization }) {
    orgs.findById.mockResolvedValue(deps.org);
    orgs.create.mockResolvedValue(deps.org);
    sagaRepo.findByIdempotencyKey.mockResolvedValue(deps.saga);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    orgs.updateStatus.mockResolvedValue(undefined);
    sagaRepo.create.mockResolvedValue(makeSaga());
    sagaRepo.advance.mockResolvedValue(undefined);
    sagaRepo.markFailed.mockResolvedValue(undefined);
    createCredentials.mockResolvedValue({ userId: 'u1' });
    assignDefaultPlan.mockResolvedValue({ subscriptionId: 's1' });
    publish.mockResolvedValue(undefined);
  });

  it('runs all steps for a brand-new signup and publishes both onboarding events', async () => {
    const org = makeOrg({ status: 'active' });
    given({ saga: null, org });

    const result = await signup(dto);

    expect(result.id).toBe(org.id);
    expect(createCredentials).toHaveBeenCalledTimes(1);
    expect(assignDefaultPlan).toHaveBeenCalledTimes(1);
    expect(sagaRepo.advance).toHaveBeenLastCalledWith(
      expect.anything(),
      'saga-1',
      SagaState.COMPLETE,
      {},
    );
    // The ORDER matters: both event types, created before provisioned.
    const publishedTypes = publish.mock.calls.map((call) => call[1].eventType);
    expect(publishedTypes).toEqual([
      EVENT_TYPES.ORGANIZATION_CREATED,
      EVENT_TYPES.ORGANIZATION_PROVISIONED,
    ]);
    // The minted userId ('u1') is the SAME id carried into OrganizationProvisioned.
    const [, provisionedEvent] = publish.mock.calls[1];
    expect(provisionedEvent.payload).toMatchObject({ adminUserId: 'u1' });
  });

  it('RESUMES from ORG_CREATED without re-creating the organisation', async () => {
    const org = makeOrg();
    given({ saga: makeSaga({ state: SagaState.ORG_CREATED, organizationId: org.id }), org });

    await signup(dto);

    expect(orgs.create).not.toHaveBeenCalled();
    expect(createCredentials).toHaveBeenCalledTimes(1);
    expect(assignDefaultPlan).toHaveBeenCalledTimes(1);
  });

  it('RESUMES from a RECORDED FAILURE at CREDENTIALS_CREATED', async () => {
    // State was NOT overwritten to a "failed" value; failedAt/lastError sit alongside it.
    const org = makeOrg();
    given({
      saga: makeSaga({
        state: SagaState.CREDENTIALS_CREATED,
        organizationId: org.id,
        adminUserId: 'admin-user-1',
        failedAt: new Date('2026-01-01T00:00:00Z'),
        lastError: 'subscription-service unreachable',
      }),
      org,
    });

    const result = await signup(dto);

    expect(orgs.create).not.toHaveBeenCalled();
    expect(createCredentials).not.toHaveBeenCalled();
    expect(assignDefaultPlan).toHaveBeenCalledTimes(1);
    expect(result.id).toBe(org.id);
    // The ORIGINALLY minted adminUserId reaches the final event, not a re-minted one.
    const provisionedCall = publish.mock.calls.find(
      (call) => call[1].eventType === EVENT_TYPES.ORGANIZATION_PROVISIONED,
    );
    expect(provisionedCall?.[1]).toMatchObject({
      payload: expect.objectContaining({ adminUserId: 'admin-user-1' }),
    });
  });

  it('returns the existing result for an already-COMPLETE saga without re-running anything', async () => {
    const org = makeOrg({ status: 'active' });
    given({ saga: makeSaga({ state: SagaState.COMPLETE, organizationId: org.id }), org });

    const result = await signup(dto);

    expect(result.id).toBe(org.id);
    expect(createCredentials).not.toHaveBeenCalled();
    expect(assignDefaultPlan).not.toHaveBeenCalled();
  });

  it('records the failure WITHOUT advancing state, marks the org provisioning_failed, and returns 409 not 500', async () => {
    const org = makeOrg();
    given({ saga: null, org });
    createCredentials.mockRejectedValue(new Error('auth-service unreachable'));

    await expect(signup(dto)).rejects.toMatchObject({
      status: 409,
      response: { error: 'ONBOARDING_INCOMPLETE' },
    });

    // ORG_CREATED is the true last-good state; markFailed never writes a state.
    expect(sagaRepo.advance).toHaveBeenCalledTimes(1);
    expect(sagaRepo.advance).toHaveBeenCalledWith(
      expect.anything(),
      'saga-1',
      SagaState.ORG_CREATED,
      {
        organizationId: org.id,
      },
    );
    expect(sagaRepo.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      'saga-1',
      expect.stringContaining('auth-service unreachable'),
    );
    expect(orgs.updateStatus).toHaveBeenCalledWith(
      expect.anything(),
      org.id,
      'provisioning_failed',
    );
    expect(publish).toHaveBeenLastCalledWith(
      'organization.events',
      expect.objectContaining({ eventType: EVENT_TYPES.ONBOARDING_FAILED }),
    );
  });

  it('records an HTTP-style error from credential creation as the former remote call did', async () => {
    given({ saga: null, org: makeOrg() });
    createCredentials.mockRejectedValue(
      new ConflictException('Email "admin@acme.test" is already registered'),
    );

    await expect(signup(dto)).rejects.toMatchObject({
      response: { error: 'ONBOARDING_INCOMPLETE' },
    });

    expect(sagaRepo.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      'saga-1',
      'Request failed with status code 409',
    );
  });

  it('does not mark the saga failed on a slug conflict — it is a naming conflict, not a saga failure', async () => {
    given({ saga: null, org: makeOrg() });
    orgs.create.mockRejectedValue(new OrganizationSlugTakenError('acme-inc'));

    await expect(signup(dto)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ message: expect.stringContaining('already taken') }),
    });

    expect(sagaRepo.markFailed).not.toHaveBeenCalled();
  });
});
