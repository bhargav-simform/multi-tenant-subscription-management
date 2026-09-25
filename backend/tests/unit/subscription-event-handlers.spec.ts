import type { EventEnvelope } from '../../src/types/events';

jest.mock('../../src/lib/tenant-db', () => ({
  transactionForOrganization: jest.fn(async (_orgId: string, work: (tx: unknown) => unknown) =>
    work({}),
  ),
}));
jest.mock('../../src/models/plan-limit-cache.model');
jest.mock('../../src/models/subscription.model');

import * as planLimitModel from '../../src/models/plan-limit-cache.model';
import * as subscriptionModel from '../../src/models/subscription.model';
import * as planLimitSync from '../../src/events/handlers/plan-limit-sync.handler';
import * as storageReconciliation from '../../src/events/handlers/storage-reconciliation.handler';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

function envelope(
  eventType: string,
  payload: unknown,
  organizationId: string | null = ORG_ID,
): EventEnvelope {
  return {
    eventId: 'e-1',
    eventType,
    eventVersion: 1,
    organizationId,
    correlationId: 'c-1',
    actorUserId: null,
    occurredAt: '',
    payload,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('plan-limit-sync handler', () => {
  it.each(['SubscriptionAssigned', 'SubscriptionChanged'])(
    'upserts the ceiling from %s',
    async (type) => {
      await planLimitSync.handle(envelope(type, { maxStorageBytes: 42 }));
      expect(planLimitModel.upsert).toHaveBeenCalledWith(expect.anything(), ORG_ID, 42);
    },
  );

  it('ignores other event types, org-less events and payloads without a ceiling', async () => {
    await planLimitSync.handle(envelope('UsageUpdated', { maxStorageBytes: 42 }));
    await planLimitSync.handle(envelope('SubscriptionChanged', { maxStorageBytes: 42 }, null));
    await planLimitSync.handle(envelope('SubscriptionChanged', {}));
    expect(planLimitModel.upsert).not.toHaveBeenCalled();
  });
});

describe('storage-reconciliation handler', () => {
  function withSubscription(used: number, max: number) {
    jest.mocked(subscriptionModel.findByOrganizationId).mockResolvedValue({
      usedStorageBytes: used,
      maxStorageSnapshot: max,
    } as never);
  }

  it('adds on ResourceCreated and subtracts on ResourceDeleted', async () => {
    withSubscription(100, 1_000);
    await storageReconciliation.handle(envelope('ResourceCreated', { sizeDelta: 50 }));
    expect(subscriptionModel.updateUsedStorageBytes).toHaveBeenLastCalledWith(
      expect.anything(),
      ORG_ID,
      150,
    );
    await storageReconciliation.handle(envelope('ResourceDeleted', { sizeDelta: 50 }));
    expect(subscriptionModel.updateUsedStorageBytes).toHaveBeenLastCalledWith(
      expect.anything(),
      ORG_ID,
      50,
    );
  });

  it('clamps to [0, max_storage_snapshot]', async () => {
    withSubscription(100, 120);
    await storageReconciliation.handle(envelope('ResourceCreated', { sizeDelta: 50 }));
    expect(subscriptionModel.updateUsedStorageBytes).toHaveBeenLastCalledWith(
      expect.anything(),
      ORG_ID,
      120,
    );
    await storageReconciliation.handle(envelope('ResourceDeleted', { sizeDelta: 500 }));
    expect(subscriptionModel.updateUsedStorageBytes).toHaveBeenLastCalledWith(
      expect.anything(),
      ORG_ID,
      0,
    );
  });

  it('does nothing without a subscription row or for other event types', async () => {
    jest.mocked(subscriptionModel.findByOrganizationId).mockResolvedValue(null);
    await storageReconciliation.handle(envelope('ResourceCreated', { sizeDelta: 50 }));
    await storageReconciliation.handle(envelope('CrossTenantAccessAttempted', {}));
    expect(subscriptionModel.updateUsedStorageBytes).not.toHaveBeenCalled();
  });
});
