import { Controller, Get, Query } from '@nestjs/common';
import { Action, Subject } from '@app/common';
import type { CursorPage } from '@app/common';
import { CheckAbility } from '@app/authorization';
import { AuditService } from './audit.service';
import { ListAuditQueryDto } from './dto/list-audit-query.dto';
import type {
  AuditEventMetadataResponseDto,
  AuditEventResponseDto,
} from './dto/audit-event-response.dto';

/**
 * §8.7's two read routes. HTTP only — no business rules, no transactions, no
 * repository access.
 *
 * §13.3: no route is `/organizations/:orgId/...` and no handler accepts an
 * organisation id anywhere. Which organisation's events come back is decided
 * entirely by the caller's token, via TenantContextStore, inside AuditService.
 *
 * There is NO write route, by design. Audit records arrive over Kafka and only
 * over Kafka (§8.7): "no service can call it synchronously, so no service can
 * be persuaded to skip writing an audit trail". A POST here would be the exact
 * hole this service exists to close.
 */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * Org Admin: their own org's events with full payloads. Platform Admin: every
   * org's events, metadata only. @CheckAbility gates the SUBJECT TYPE — both
   * roles legitimately hold `can(READ, AuditEvent)` in the shared CASL factory
   * — and the projection difference between them is made in the service, where
   * the caller's identity is known (§12.5).
   */
  @Get()
  @CheckAbility(Action.READ, Subject.AUDIT_EVENT)
  list(
    @Query() query: ListAuditQueryDto,
  ): Promise<CursorPage<AuditEventResponseDto | AuditEventMetadataResponseDto>> {
    return this.audit.listAuditEvents(query);
  }

  /**
   * §8.7: PLATFORM ADMIN ONLY — stricter than the @CheckAbility below it, which
   * an ORG_ADMIN also satisfies (`can(READ, AUDIT_EVENT, { organizationId })`;
   * the condition needs a loaded instance CASL has none of at guard time, §12.5).
   * `AuditService.listSecurityEvents` carries the explicit platform-admin check
   * that actually enforces this. The decorator is kept as the coarse first gate,
   * not as the enforcement — an ORG_MEMBER, who holds no AUDIT_EVENT ability at
   * all, is rejected here before reaching the service.
   */
  @Get('security')
  @CheckAbility(Action.READ, Subject.AUDIT_EVENT)
  listSecurity(@Query() query: ListAuditQueryDto): Promise<CursorPage<AuditEventResponseDto>> {
    return this.audit.listSecurityEvents(query);
  }
}
