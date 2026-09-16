import { jest, describe, it, expect } from '@jest/globals';
import { EVENT_TYPES, KAFKA_TOPICS, type EventEnvelope } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import type { TenantAwareDataSource } from '@app/database';
import type { ConsumedEventStore, KafkaModuleOptions } from '@app/kafka';
import type {
  CreateAuditRecordData,
  IAuditEventRepository,
  ISecurityEventRepository,
} from '../../audit/audit-record.repository.interface';
import type { AuditEvent } from '../../audit/audit-event.entity';
import type { SecurityEvent } from '../../audit/security-event.entity';
import {
  OrganizationEventsConsumer,
  ResourceEventsConsumer,
  SubscriptionEventsConsumer,
  UserEventsConsumer,
} from '../content-topic.consumers';
import { SecurityEventsConsumer } from '../security-events.consumer';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

/**
 * §8.7's five consumers. What these prove is the CLASSIFICATION — which table
 * an event lands in, at which severity, and (just as important) which
 * transaction method opens the scope it is written under.
 *
 * WHAT THESE CANNOT PROVE: the fake TenantAwareDataSource does no scoping, so
 * the RLS WITH CHECK that actually decides whether a NULL-org row may be
 * written is not exercised here at all. That is the single most surprising
 * behaviour in this service — under the STANDARD enableTenantRls() policy shape
 * an unscoped NULL-org insert is REJECTED — and it is verified against real
 * PostgreSQL in test/integration/audit-service/, never here.
 */
describe('audit-service Kafka consumers (§8.7)', () => {
  function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
    return {
      eventId: 'eeeeeeee-0000-0000-0000-000000000001',
      eventType: EVENT_TYPES.RESOURCE_CREATED,
      eventVersion: 1,
      organizationId: ORG_A,
      correlationId: 'cccccccc-0000-0000-0000-000000000001',
      actorUserId: USER_ID,
      occurredAt: '2025-01-01T00:00:00.000Z',
      payload: { name: 'report.pdf' },
      ...overrides,
    };
  }

  /**
   * BaseKafkaConsumer's constructor builds a kafkajs client object but opens no
   * connection (that happens in onModuleInit, which is never called here), so a
   * consumer can be constructed directly in a unit test.
   */
  const kafkaOptions: KafkaModuleOptions = {
    brokers: ['localhost:9092'],
    clientIdPrefix: 'test',
    serviceName: 'audit-service',
    groupId: 'audit-service-group',
  };

  const consumedEvents: ConsumedEventStore = {
    wasConsumed: jest.fn<ConsumedEventStore['wasConsumed']>().mockResolvedValue(false),
    markConsumed: jest.fn<ConsumedEventStore['markConsumed']>().mockResolvedValue(undefined),
  };

  function buildDeps() {
    const created: { table: 'audit' | 'security'; data: CreateAuditRecordData }[] = [];

    const dataSource = {
      runGlobal: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) => work({})),
      transactionForOrganization: jest
        .fn<(orgId: string, work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (_orgId, work) => work({})),
      transaction: jest.fn(),
    };

    const auditEvents = {
      create: jest
        .fn<(data: CreateAuditRecordData, m: unknown) => Promise<AuditEvent>>()
        .mockImplementation(async (data) => {
          created.push({ table: 'audit', data });
          return {} as AuditEvent;
        }),
      listPage: jest.fn(),
      listAllForPlatformAdmin: jest.fn(),
    } as unknown as IAuditEventRepository & {
      create: jest.Mock<(data: CreateAuditRecordData, m: unknown) => Promise<AuditEvent>>;
    };

    const securityEvents = {
      create: jest
        .fn<(data: CreateAuditRecordData, m: unknown) => Promise<SecurityEvent>>()
        .mockImplementation(async (data) => {
          created.push({ table: 'security', data });
          return {} as SecurityEvent;
        }),
      listPage: jest.fn(),
      listAllForPlatformAdmin: jest.fn(),
    } as unknown as ISecurityEventRepository & {
      create: jest.Mock<(data: CreateAuditRecordData, m: unknown) => Promise<SecurityEvent>>;
    };

    return { created, dataSource, auditEvents, securityEvents };
  }

  /** `handle` is protected — this is the one honest way to drive it from a test. */
  function invokeHandle(consumer: object, env: EventEnvelope): Promise<void> {
    return (consumer as { handle(e: EventEnvelope): Promise<void> }).handle(env);
  }

  const contentConsumers = [
    { name: 'OrganizationEventsConsumer', Ctor: OrganizationEventsConsumer, topic: KAFKA_TOPICS.ORGANIZATION, eventType: EVENT_TYPES.ORGANIZATION_CREATED },
    { name: 'UserEventsConsumer', Ctor: UserEventsConsumer, topic: KAFKA_TOPICS.USER, eventType: EVENT_TYPES.USER_INVITED },
    { name: 'SubscriptionEventsConsumer', Ctor: SubscriptionEventsConsumer, topic: KAFKA_TOPICS.SUBSCRIPTION, eventType: EVENT_TYPES.SUBSCRIPTION_ASSIGNED },
    { name: 'ResourceEventsConsumer', Ctor: ResourceEventsConsumer, topic: KAFKA_TOPICS.RESOURCE, eventType: EVENT_TYPES.RESOURCE_CREATED },
  ] as const;

  describe('the four content-topic consumers -> audit_events', () => {
    it.each(contentConsumers)(
      '$name subscribes to $topic and writes to audit_events at severity "info"',
      async ({ Ctor, topic, eventType }) => {
        const { created, dataSource, auditEvents } = buildDeps();
        const consumer = new Ctor(
          kafkaOptions,
          new TenantContextStore(),
          consumedEvents,
          dataSource as unknown as TenantAwareDataSource,
          auditEvents,
        );

        // One class per topic, because BaseKafkaConsumer subscribes to exactly
        // one (`protected abstract readonly topic`).
        expect((consumer as unknown as { topic: string }).topic).toBe(topic);

        await invokeHandle(consumer, envelope({ eventType }));

        expect(created).toHaveLength(1);
        expect(created[0].table).toBe('audit');
        expect(created[0].data.severity).toBe('info');
        expect(created[0].data.eventType).toBe(eventType);
      },
    );

    it('carries every envelope field through verbatim, including the payload unreshaped', async () => {
      const { created, dataSource, auditEvents } = buildDeps();
      const consumer = new ResourceEventsConsumer(
        kafkaOptions,
        new TenantContextStore(),
        consumedEvents,
        dataSource as unknown as TenantAwareDataSource,
        auditEvents,
      );

      await invokeHandle(consumer, envelope({ payload: { name: 'report.pdf', sizeBytes: 42 } }));

      expect(created[0].data).toMatchObject({
        eventId: 'eeeeeeee-0000-0000-0000-000000000001',
        organizationId: ORG_A,
        actorUserId: USER_ID,
        correlationId: 'cccccccc-0000-0000-0000-000000000001',
        // An audit sink does not interpret or trim what it records.
        payload: { name: 'report.pdf', sizeBytes: 42 },
      });
      // occurredAt is the EVENT's time, parsed from the envelope's ISO string —
      // not the ingest time.
      expect(created[0].data.occurredAt).toEqual(new Date('2025-01-01T00:00:00.000Z'));
    });

    it('opens the transaction scoped to the ENVELOPE\'s organizationId (§13.4)', async () => {
      const { dataSource, auditEvents } = buildDeps();
      const consumer = new UserEventsConsumer(
        kafkaOptions,
        new TenantContextStore(),
        consumedEvents,
        dataSource as unknown as TenantAwareDataSource,
        auditEvents,
      );

      await invokeHandle(consumer, envelope({ eventType: EVENT_TYPES.USER_CREATED }));

      // The scope must match the row's organization_id or the RLS WITH CHECK
      // rejects the write — the envelope is the authority, never ambient state.
      expect(dataSource.transactionForOrganization).toHaveBeenCalledWith(
        ORG_A,
        expect.any(Function),
      );
      expect(dataSource.runGlobal).not.toHaveBeenCalled();
    });

    /**
     * §17.3 lists PlanLimitExceeded as a rejection. NO SERVICE PUBLISHES IT
     * TODAY (verified by grep: EVENT_TYPES.PLAN_LIMIT_EXCEEDED matches only its
     * own definition; the 409 path raises PlanLimitExceededException and returns
     * synchronously). The classification is nevertheless wired and tested so the
     * event is handled correctly the day a service adds that publish call —
     * §8.7 forbids this pure sink from acquiring a publisher to emit it itself.
     */
    it('classifies PlanLimitExceeded as "warn" — ready for a publisher that does not exist yet', async () => {
      const { created, dataSource, auditEvents } = buildDeps();
      const consumer = new SubscriptionEventsConsumer(
        kafkaOptions,
        new TenantContextStore(),
        consumedEvents,
        dataSource as unknown as TenantAwareDataSource,
        auditEvents,
      );

      await invokeHandle(consumer, envelope({ eventType: EVENT_TYPES.PLAN_LIMIT_EXCEEDED }));

      expect(created[0].table).toBe('audit');
      expect(created[0].data.severity).toBe('warn');
    });

    it('records an event type it has never been taught about, rather than skipping it', async () => {
      const { created, dataSource, auditEvents } = buildDeps();
      const consumer = new OrganizationEventsConsumer(
        kafkaOptions,
        new TenantContextStore(),
        consumedEvents,
        dataSource as unknown as TenantAwareDataSource,
        auditEvents,
      );

      await invokeHandle(consumer, envelope({ eventType: 'SomeFutureEventNobodyToldUsAbout' }));

      // A sink that dropped unrecognised events would make the trail silently
      // incomplete exactly when a new feature shipped.
      expect(created).toHaveLength(1);
      expect(created[0].data.severity).toBe('info');
    });
  });

  describe('SecurityEventsConsumer -> security_events (§13.9, §26)', () => {
    function buildSecurityConsumer() {
      const deps = buildDeps();
      const consumer = new SecurityEventsConsumer(
        kafkaOptions,
        new TenantContextStore(),
        consumedEvents,
        deps.dataSource as unknown as TenantAwareDataSource,
        deps.securityEvents,
      );
      return { ...deps, consumer };
    }

    it('subscribes to security.events', () => {
      const { consumer } = buildSecurityConsumer();
      expect((consumer as unknown as { topic: string }).topic).toBe(KAFKA_TOPICS.SECURITY);
    });

    /**
     * §13.9: NO RECONCILIATION HAPPENS HERE, and that is the design. The source
     * services already ran a SECURITY DEFINER existence probe (`resource_exists`,
     * `users.user_exists`) BEFORE publishing and publish nothing when the id
     * genuinely does not exist. By the time an event arrives it is an already-
     * confirmed cross-tenant attempt, so it is written straight through at
     * `security`.
     */
    it('writes CrossTenantAccessAttempted to security_events at "security" with NO further reconciliation', async () => {
      const { consumer, created, securityEvents, auditEvents } = buildSecurityConsumer();

      await invokeHandle(
        consumer,
        envelope({
          eventType: EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED,
          payload: {
            subjectType: 'Resource',
            subjectId: 'dddddddd-0000-0000-0000-000000000001',
            actorOrganizationId: ORG_A,
            actorUserId: USER_ID,
          },
        }),
      );

      expect(created).toHaveLength(1);
      expect(created[0].table).toBe('security');
      expect(created[0].data.severity).toBe('security');
      // It never touches audit_events, and never probes anything to decide.
      expect(auditEvents.create).not.toHaveBeenCalled();
      expect(securityEvents.create).toHaveBeenCalledTimes(1);
    });

    it('writes AuthenticationFailed to security_events at "security" too', async () => {
      const { consumer, created } = buildSecurityConsumer();

      await invokeHandle(
        consumer,
        envelope({
          eventType: EVENT_TYPES.AUTHENTICATION_FAILED,
          actorUserId: null,
          payload: { email: 'nobody@example.com', reason: 'unknown_email' },
        }),
      );

      expect(created[0].table).toBe('security');
      expect(created[0].data.severity).toBe('security');
      expect(created[0].data.actorUserId).toBeNull();
    });

    /**
     * THE PLATFORM-LEVEL PATH. auth-service publishes AuthenticationFailed with
     * organizationId: null when a login fails for an email that maps to no
     * credential — there is no org to attach, because establishing one is what
     * failed. The consumer must open an UNSCOPED transaction for it, because the
     * RLS policy only permits a NULL-org row when app.current_org is also unset.
     */
    it('uses runGlobal() — not transactionForOrganization — when the envelope has NO organizationId', async () => {
      const { consumer, created, dataSource } = buildSecurityConsumer();

      await invokeHandle(
        consumer,
        envelope({
          eventType: EVENT_TYPES.AUTHENTICATION_FAILED,
          organizationId: null,
          actorUserId: null,
          payload: { email: 'nobody@example.com', reason: 'unknown_email' },
        }),
      );

      expect(dataSource.runGlobal).toHaveBeenCalled();
      expect(dataSource.transactionForOrganization).not.toHaveBeenCalled();
      expect(created[0].data.organizationId).toBeNull();
    });

    it('scopes to the org when the security event DOES carry one', async () => {
      const { consumer, dataSource } = buildSecurityConsumer();

      await invokeHandle(
        consumer,
        envelope({ eventType: EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED }),
      );

      expect(dataSource.transactionForOrganization).toHaveBeenCalledWith(
        ORG_A,
        expect.any(Function),
      );
      expect(dataSource.runGlobal).not.toHaveBeenCalled();
    });

    it('records an UNRECOGNISED security-topic event at "security" anyway, rather than dropping it', async () => {
      const { consumer, created } = buildSecurityConsumer();

      await invokeHandle(consumer, envelope({ eventType: 'SomeNewDetectionSignal' }));

      // Either a new detection signal nobody updated the list for, or something
      // publishing to the security topic that should not be. Both deserve a
      // durable record; neither deserves a lost one.
      expect(created[0].table).toBe('security');
      expect(created[0].data.severity).toBe('security');
    });
  });
});
