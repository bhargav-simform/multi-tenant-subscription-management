import { jest, describe, it, expect } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { Role } from '@app/common';
import type { CursorPage } from '@app/common';
import { AuditService } from '../audit.service';
import {
  AUDIT_EVENT_REPOSITORY,
  SECURITY_EVENT_REPOSITORY,
} from '../audit-record.repository.interface';
import type { AuditRecordBaseEntity } from '../audit-record-base.entity';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';

/**
 * §8.7's two read routes. These tests prove the AUTHORIZATION shape of this
 * service — which is unusually load-bearing here, because two of the three
 * rules cannot be enforced by RLS at all:
 *
 *   1. the platform-admin metadata projection is a COLUMN-level distinction,
 *      and RLS filters rows, not columns;
 *   2. `GET /audit/security` being platform-admin-only is stricter than the
 *      shared CASL factory's `can(READ, AUDIT_EVENT)`, which an ORG_ADMIN also
 *      holds.
 *
 * WHAT THESE TESTS CANNOT PROVE, stated plainly: the fake TenantAwareDataSource
 * below does no scoping at all, so nothing here would catch a repository that
 * forgot its org predicate or a missing RLS policy. Only
 * test/integration/audit-service/ exercises real RLS against real PostgreSQL.
 * Both suites are required; neither substitutes for the other.
 */
describe('AuditService', () => {
  function makeRecord(overrides: Partial<AuditRecordBaseEntity> = {}): AuditRecordBaseEntity {
    return {
      id: 'aaaaaaaa-0000-0000-0000-000000000001',
      eventId: 'bbbbbbbb-0000-0000-0000-000000000001',
      eventType: 'ResourceCreated',
      organizationId: ORG_A,
      actorUserId: USER_ID,
      correlationId: 'cccccccc-0000-0000-0000-000000000001',
      severity: 'info',
      // The field the platform-admin projection must withhold: a resource NAME
      // is organisation content (§8.7, §13.6).
      payload: { name: 'org-a-quarterly-results.pdf' },
      occurredAt: new Date('2025-01-01T00:00:00.000Z'),
      createdAt: new Date('2025-01-01T00:00:01.000Z'),
      ...overrides,
    } as AuditRecordBaseEntity;
  }

  function page(items: AuditRecordBaseEntity[]): CursorPage<AuditRecordBaseEntity> {
    return { items, hasMore: false, nextCursor: null };
  }

  function buildContext(roles: Role[], organizationId: string | null) {
    return { userId: USER_ID, organizationId, roles, correlationId: 'corr-1', iat: 0, exp: 0 };
  }

  async function buildService(deps: {
    ownOrgEvents?: AuditRecordBaseEntity[];
    allOrgEvents?: AuditRecordBaseEntity[];
    securityEvents?: AuditRecordBaseEntity[];
  }) {
    const tenantContext = new TenantContextStore();

    const dataSource = {
      transaction: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) => work({})),
      // §13.6: the platform-admin path. Real runGlobal() leaves app.current_org
      // unset; this fake just runs the callback, which is why the tests below
      // assert WHICH method was called rather than trusting the result alone.
      runGlobal: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) => work({})),
      transactionForOrganization: jest
        .fn<(orgId: string, work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (_orgId, work) => work({})),
    };

    const auditEvents = {
      create: jest.fn(),
      listPage: jest
        .fn<(q: unknown, m: unknown) => Promise<CursorPage<AuditRecordBaseEntity>>>()
        .mockResolvedValue(page(deps.ownOrgEvents ?? [makeRecord()])),
      listAllForPlatformAdmin: jest
        .fn<(q: unknown, m: unknown) => Promise<CursorPage<AuditRecordBaseEntity>>>()
        .mockResolvedValue(
          page(deps.allOrgEvents ?? [makeRecord(), makeRecord({ organizationId: ORG_B })]),
        ),
    };

    const securityEvents = {
      create: jest.fn(),
      listPage: jest
        .fn<(q: unknown, m: unknown) => Promise<CursorPage<AuditRecordBaseEntity>>>()
        .mockResolvedValue(page([])),
      listAllForPlatformAdmin: jest
        .fn<(q: unknown, m: unknown) => Promise<CursorPage<AuditRecordBaseEntity>>>()
        .mockResolvedValue(
          page(
            deps.securityEvents ?? [
              makeRecord({
                eventType: 'CrossTenantAccessAttempted',
                severity: 'security',
                payload: {
                  subjectType: 'Resource',
                  subjectId: 'dddddddd-0000-0000-0000-000000000001',
                  actorOrganizationId: ORG_A,
                  actorUserId: USER_ID,
                },
              }),
            ],
          ),
        ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: TenantAwareDataSource, useValue: dataSource },
        { provide: TenantContextStore, useValue: tenantContext },
        { provide: AUDIT_EVENT_REPOSITORY, useValue: auditEvents },
        { provide: SECURITY_EVENT_REPOSITORY, useValue: securityEvents },
      ],
    }).compile();

    return {
      service: moduleRef.get(AuditService),
      tenantContext,
      auditEvents,
      securityEvents,
      dataSource,
    };
  }

  describe('GET /audit — org admin (§8.7)', () => {
    it("returns their OWN org's events WITH the full payload", async () => {
      const { service, tenantContext, auditEvents } = await buildService({});

      const result = await tenantContext.run(
        buildContext([Role.ORG_ADMIN], ORG_A),
        () => service.listAuditEvents({}),
      );

      expect(result.items).toHaveLength(1);
      // The whole point of the org-admin branch: the trace is largely IN the
      // payload, so withholding it would make the endpoint useless to them.
      expect(result.items[0]).toHaveProperty('payload', {
        name: 'org-a-quarterly-results.pdf',
      });
      // Org-SCOPED read, not the cross-org one.
      expect(auditEvents.listPage).toHaveBeenCalled();
      expect(auditEvents.listAllForPlatformAdmin).not.toHaveBeenCalled();
    });

    it('goes through the org-scoped transaction(), never runGlobal()', async () => {
      const { service, tenantContext, dataSource } = await buildService({});

      await tenantContext.run(buildContext([Role.ORG_ADMIN], ORG_A), () =>
        service.listAuditEvents({}),
      );

      // §13.5: transaction() sets app.current_org, which is what makes RLS
      // filter this read. runGlobal() would leave it unset.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(dataSource.runGlobal).not.toHaveBeenCalled();
    });

    it('propagates the cursor page shape unchanged (§29)', async () => {
      const { service, tenantContext, auditEvents } = await buildService({});
      auditEvents.listPage.mockResolvedValue({
        items: [makeRecord()],
        hasMore: true,
        nextCursor: 'opaque-cursor',
      });

      const result = await tenantContext.run(
        buildContext([Role.ORG_ADMIN], ORG_A),
        () => service.listAuditEvents({ limit: 1 }),
      );

      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe('opaque-cursor');
    });
  });

  describe('GET /audit — platform admin (§8.7 "metadata-level events only")', () => {
    it('returns events ACROSS orgs but STRIPS the payload from every one of them', async () => {
      const { service, tenantContext, auditEvents } = await buildService({});

      const result = await tenantContext.run(
        buildContext([Role.PLATFORM_ADMIN], null),
        () => service.listAuditEvents({}),
      );

      expect(result.items).toHaveLength(2);
      for (const item of result.items) {
        // THE ASSERTION THAT MATTERS. Not "payload is undefined" — the key must
        // be ABSENT, because a serialised `"payload": null` would still tell a
        // platform admin an event had one, and a future `delete`-based
        // implementation would pass a looser check while leaking on refactor.
        expect(Object.keys(item)).not.toContain('payload');
      }
      // Metadata IS returned — this is a projection, not a denial.
      expect(result.items[0]).toMatchObject({
        eventType: 'ResourceCreated',
        organizationId: ORG_A,
        actorUserId: USER_ID,
        severity: 'info',
      });
      expect(result.items[1]).toMatchObject({ organizationId: ORG_B });
    });

    it('reads cross-org through runGlobal(), not the org-scoped transaction()', async () => {
      const { service, tenantContext, dataSource, auditEvents } = await buildService({});

      await tenantContext.run(buildContext([Role.PLATFORM_ADMIN], null), () =>
        service.listAuditEvents({}),
      );

      // §13.6: a platform admin has no organizationId, so there is nothing to
      // scope by — transaction() would throw on the null org.
      expect(dataSource.runGlobal).toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(auditEvents.listAllForPlatformAdmin).toHaveBeenCalled();
      expect(auditEvents.listPage).not.toHaveBeenCalled();
    });

    /**
     * §13.6: a token claiming PLATFORM_ADMIN while ALSO carrying an
     * organizationId is malformed — the null org is what makes the content
     * boundary structural. It must fall into the ORG-SCOPED branch, not the
     * cross-org one, or the malformed token would read every organisation.
     */
    it('a PLATFORM_ADMIN role with a NON-null organizationId is treated as org-scoped, not cross-org', async () => {
      const { service, tenantContext, auditEvents, dataSource } = await buildService({});

      const result = await tenantContext.run(
        buildContext([Role.PLATFORM_ADMIN], ORG_A),
        () => service.listAuditEvents({}),
      );

      expect(auditEvents.listAllForPlatformAdmin).not.toHaveBeenCalled();
      expect(auditEvents.listPage).toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalled();
      // And it gets the org-scoped FULL shape, because it is being treated as
      // an ordinary org-scoped caller.
      expect(result.items[0]).toHaveProperty('payload');
    });
  });

  describe('GET /audit/security — platform admin ONLY (§8.7)', () => {
    it('returns FULL security rows, payload included, for a platform admin', async () => {
      const { service, tenantContext, securityEvents, dataSource } = await buildService({});

      const result = await tenantContext.run(
        buildContext([Role.PLATFORM_ADMIN], null),
        () => service.listSecurityEvents({}),
      );

      expect(result.items).toHaveLength(1);
      // §8.7 says platform admin gets full security_events rows — a security
      // payload is {subjectType, subjectId, actorOrganizationId, actorUserId}
      // by construction, never arbitrary org content, so there is nothing to
      // withhold and withholding it would blind the detector (§13.9, §26).
      expect(result.items[0].payload).toEqual({
        subjectType: 'Resource',
        subjectId: 'dddddddd-0000-0000-0000-000000000001',
        actorOrganizationId: ORG_A,
        actorUserId: USER_ID,
      });
      expect(result.items[0].severity).toBe('security');
      expect(securityEvents.listAllForPlatformAdmin).toHaveBeenCalled();
      expect(dataSource.runGlobal).toHaveBeenCalled();
    });

    /**
     * THE CHECK CASL CANNOT MAKE. The shared factory grants ORG_ADMIN
     * `can(READ, AUDIT_EVENT, { organizationId })`, so @CheckAbility(READ,
     * AUDIT_EVENT) on the route PASSES for them — a CASL condition needs a
     * loaded instance, and no instance is loaded for a list (§12.5). Without
     * the service-level check, an org admin would reach the cross-org security
     * feed.
     *
     * 403, not 404, and deliberately: §13's "cross-tenant returns 404" rule is
     * about not confirming whether a specific ROW exists in another tenant.
     * Nothing is looked up here — this is a fixed, documented route (§8.7's
     * route table) being refused to a role, which is what 403 means. Matches
     * tenant-service's requirePlatformAdmin() on identical reasoning.
     */
    it('REJECTS an org admin with 403 — stricter than the CASL rule they satisfy', async () => {
      const { service, tenantContext, securityEvents, dataSource } = await buildService({});

      await expect(
        tenantContext.run(buildContext([Role.ORG_ADMIN], ORG_A), () =>
          service.listSecurityEvents({}),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // And it is rejected BEFORE any query runs — not filtered afterwards.
      expect(securityEvents.listAllForPlatformAdmin).not.toHaveBeenCalled();
      expect(securityEvents.listPage).not.toHaveBeenCalled();
      expect(dataSource.runGlobal).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('REJECTS an org member with 403 too', async () => {
      const { service, tenantContext } = await buildService({});

      await expect(
        tenantContext.run(buildContext([Role.ORG_MEMBER], ORG_A), () =>
          service.listSecurityEvents({}),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('REJECTS a PLATFORM_ADMIN role carrying a non-null organizationId (malformed token)', async () => {
      const { service, tenantContext } = await buildService({});

      await expect(
        tenantContext.run(buildContext([Role.PLATFORM_ADMIN], ORG_A), () =>
          service.listSecurityEvents({}),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
