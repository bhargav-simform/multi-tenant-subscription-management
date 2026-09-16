import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { CursorPage, CursorQuery } from '@app/common';
import { Role } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import { TenantAwareDataSource } from '@app/database';
import type { AuditRecordBaseEntity } from './audit-record-base.entity';
import {
  AUDIT_EVENT_REPOSITORY,
  SECURITY_EVENT_REPOSITORY,
  type IAuditEventRepository,
  type ISecurityEventRepository,
} from './audit-record.repository.interface';
import {
  AuditEventMetadataResponseDto,
  AuditEventResponseDto,
} from './dto/audit-event-response.dto';

/**
 * §8.7. Orchestration and transaction boundaries only — and, unusually for this
 * codebase, the authorization decisions that CASL structurally cannot make.
 *
 * This service PUBLISHES NOTHING (§8.7: "Publishes: nothing. It is a pure
 * sink."), so it has no EventPublisher dependency and must not acquire one.
 * An audit log that emits events is an audit log that can be made to lie about
 * itself by whatever consumes them.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(AUDIT_EVENT_REPOSITORY) private readonly auditEvents: IAuditEventRepository,
    @Inject(SECURITY_EVENT_REPOSITORY) private readonly securityEvents: ISecurityEventRepository,
    private readonly tenantDataSource: TenantAwareDataSource,
    private readonly tenantContext: TenantContextStore,
  ) {}

  /**
   * §8.7's `GET /audit`. ONE route, TWO genuinely different reads, selected by
   * the caller's role and never by a request parameter:
   *
   *   Org Admin      -> their own org's events, RLS-scoped, FULL payload.
   *   Platform Admin -> every org's events, METADATA ONLY (no payload).
   *
   * The branch is on `isPlatformAdmin()` — i.e. on `organizationId === null`,
   * the same property §13.6 makes the structural basis of the platform-admin
   * boundary — rather than on a role string alone, because the two must agree:
   * a context with PLATFORM_ADMIN in its roles AND a non-null organizationId is
   * malformed, and treating it as a platform admin would let it read every org
   * through an org-scoped transaction. `requirePlatformAdmin` below rejects that
   * combination explicitly; here, the org-scoped branch is the safe default it
   * falls into.
   */
  async listAuditEvents(
    query: CursorQuery,
  ): Promise<CursorPage<AuditEventResponseDto | AuditEventMetadataResponseDto>> {
    if (this.isPlatformAdminContext()) {
      // §13.6: no organisation to scope by, so runGlobal() — the transaction
      // runs with app.current_org unset. On these two tables (unlike every
      // other tenant table in the system) that is NOT "sees nothing": the
      // nullable-org-aware policy makes it "sees the platform-level rows",
      // which is why the cross-org read below needs the platform-admin check
      // above it AND the metadata projection below it, not just RLS.
      const page = await this.tenantDataSource.runGlobal((manager) =>
        this.auditEvents.listAllForPlatformAdmin(query, manager),
      );
      return mapPage(page, toMetadataDto);
    }

    const page = await this.tenantDataSource.transaction((manager) =>
      this.auditEvents.listPage(query, manager),
    );
    return mapPage(page, toFullDto);
  }

  /**
   * §8.7's `GET /audit/security`: "Platform Admin: cross-tenant attempts across
   * all orgs". FULL rows, deliberately — a security event's payload is
   * `{subjectType, subjectId, actorOrganizationId, actorUserId}` or
   * `{email, reason}` by construction (see the publishers in resource-service,
   * user-service and auth-service), never arbitrary organisation content, so
   * the §8.7 projection that applies to `GET /audit` has nothing to protect
   * here and would only blind the detector.
   *
   * PLATFORM ADMIN ONLY — and this check is the enforcement, not decoration.
   * CASL's shared factory grants `can(READ, AUDIT_EVENT)` to ORG_ADMIN too
   * (scoped by `{ organizationId }`), so `@CheckAbility(READ, AUDIT_EVENT)` on
   * the route passes for an org admin: a CASL condition needs a LOADED INSTANCE
   * to evaluate, and this method's whole point is that no single instance is
   * being loaded (§12.5). Exactly tenant-service's `listOrganizations()`
   * situation, handled exactly the same way, and for the same reason.
   *
   * Nor does RLS cover the gap: reached by an org admin, the transaction would
   * be org-scoped and would return that org's OWN security events — not a leak,
   * but still an endpoint §8.7 does not give them. The explicit check is what
   * makes the route's contract match its documentation.
   */
  async listSecurityEvents(query: CursorQuery): Promise<CursorPage<AuditEventResponseDto>> {
    this.requirePlatformAdmin();

    const page = await this.tenantDataSource.runGlobal((manager) =>
      this.securityEvents.listAllForPlatformAdmin(query, manager),
    );
    return mapPage(page, toFullDto);
  }

  /**
   * §13.6: a platform admin is a context whose token carries the PLATFORM_ADMIN
   * role AND a null organizationId. BOTH are required — the null org is what
   * makes the content boundary structural, and a token claiming the role while
   * carrying an org is malformed, not privileged.
   */
  private isPlatformAdminContext(): boolean {
    const ctx = this.tenantContext.getOrThrow();
    return ctx.roles.includes(Role.PLATFORM_ADMIN) && ctx.organizationId === null;
  }

  /**
   * 403, not 404 — and the distinction is deliberate rather than incidental.
   * §13's "cross-tenant returns 404, never 403" rule is about not confirming
   * whether a specific row EXISTS in another tenant. Nothing is being looked up
   * here: `/audit/security` is a fixed, documented route whose existence is
   * public knowledge (§8.7's route table), and refusing it tells the caller
   * nothing about any organisation's data. This is a plain "your role may not
   * use this endpoint", which is what 403 means. tenant-service's
   * `requirePlatformAdmin()` answers 403 on identical reasoning; matching it
   * keeps one consistent story across the system.
   */
  private requirePlatformAdmin(): void {
    if (!this.isPlatformAdminContext()) {
      throw new ForbiddenException('Platform admin access required');
    }
  }
}

function mapPage<T, R>(page: CursorPage<T>, map: (row: T) => R): CursorPage<R> {
  return { items: page.items.map(map), nextCursor: page.nextCursor, hasMore: page.hasMore };
}

function toMetadataDto(row: AuditRecordBaseEntity): AuditEventMetadataResponseDto {
  // Field-by-field, NEVER a spread-and-delete of the entity. A spread would put
  // `payload` in the object and rely on a later `delete` to remove it — one
  // refactor away from shipping organisation content to a platform admin, and
  // invisible in a diff. Listing the allowed fields means a new column is
  // withheld by DEFAULT and has to be added here deliberately (§8.7).
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    organizationId: row.organizationId,
    actorUserId: row.actorUserId,
    correlationId: row.correlationId,
    severity: row.severity,
    occurredAt: row.occurredAt,
  };
}

function toFullDto(row: AuditRecordBaseEntity): AuditEventResponseDto {
  return { ...toMetadataDto(row), payload: row.payload };
}
