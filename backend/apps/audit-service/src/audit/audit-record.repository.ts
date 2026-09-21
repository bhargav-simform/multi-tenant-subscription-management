import { Injectable } from '@nestjs/common';
import { EntityManager, EntityTarget } from 'typeorm';
import type { CursorPage } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import { TenantRepository } from '@app/database';
import { AuditEvent } from './audit-event.entity';
import { SecurityEvent } from './security-event.entity';
import type { AuditRecordBaseEntity } from './audit-record-base.entity';
import type { ListAuditQueryDto } from './dto/list-audit-query.dto';
import type {
  CreateAuditRecordData,
  IAuditEventRepository,
  IAuditRecordRepository,
  ISecurityEventRepository,
} from './audit-record.repository.interface';

const DEFAULT_PAGE_SIZE = 20;

/**
 * §13.5: extends TenantRepository, so the org-scoped read is scoped in
 * readable application code as well as by RLS underneath ("second mechanism").
 * `audit_events` and `security_events` are column-for-column identical (§8.7:
 * "same shape"), so the query logic lives here once and the two concrete
 * subclasses below differ only in which entity they target — duplicating ~60
 * lines of keyset pagination twice would create two places for a cursor bug to
 * diverge.
 *
 * Every method takes a REQUIRED `manager` from a transaction the caller
 * already opened through TenantAwareDataSource (§32.4). There is no fallback to
 * a raw, unscoped DataSource anywhere in this service.
 */
@Injectable()
export abstract class AuditRecordRepository<T extends AuditRecordBaseEntity>
  extends TenantRepository<T>
  implements IAuditRecordRepository<T>
{
  constructor(tenantContext: TenantContextStore) {
    super(tenantContext);
  }

  /**
   * Written from a Kafka consumer, inside a transaction the consumer opened
   * with `transactionForOrganization(envelope.organizationId, ...)` when the
   * envelope carries an org, or `runGlobal(...)` when it does not.
   *
   * `organizationId` comes from `data` (the envelope), NOT from the inherited
   * `organizationId` getter — that getter throws when context has no org, which
   * is precisely the legitimate platform-level-event case here (§13.4: a
   * consumer's authority for which tenant an event belongs to is the envelope).
   * The RLS WITH CHECK still has the final say: the value written must match the
   * scope the transaction was opened with, or Postgres rejects the row. A
   * consumer cannot write org B's audit record from an org-A-scoped
   * transaction even if the envelope claimed it could.
   */
  async create(data: CreateAuditRecordData, manager: EntityManager): Promise<T> {
    const repo = manager.getRepository<T>(this.entityTarget);
    const record = repo.create({
      eventId: data.eventId,
      eventType: data.eventType,
      organizationId: data.organizationId,
      actorUserId: data.actorUserId,
      correlationId: data.correlationId,
      severity: data.severity,
      payload: data.payload,
      occurredAt: data.occurredAt,
    } as Parameters<typeof repo.create>[0]);
    return repo.save(record);
  }

  /** §29, §14.4: keyset pagination on (occurred_at DESC, id) within the caller's org. */
  async listPage(query: ListAuditQueryDto, manager: EntityManager): Promise<CursorPage<T>> {
    return this.paginate(query, manager, this.organizationId);
  }

  /**
   * §13.6: no org predicate at all — the caller MUST have opened this
   * transaction via `runGlobal()` and MUST have already asserted the caller is a
   * platform admin (AuditService.requirePlatformAdmin does both). Reached with an
   * org-scoped transaction by mistake, this degrades to that org's rows rather
   * than leaking, because RLS is still applied; reached with no platform-admin
   * check, it is a cross-org read — which is why that check is not optional and
   * does not live here.
   */
  async listAllForPlatformAdmin(
    query: ListAuditQueryDto,
    manager: EntityManager,
  ): Promise<CursorPage<T>> {
    return this.paginate(query, manager, null);
  }

  private async paginate(
    query: ListAuditQueryDto,
    manager: EntityManager,
    organizationId: string | null,
  ): Promise<CursorPage<T>> {
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, 100);
    const qb = manager
      .getRepository<T>(this.entityTarget)
      .createQueryBuilder('e')
      .orderBy('e.occurredAt', 'DESC')
      .addOrderBy('e.id', 'DESC')
      .take(limit + 1);

    if (organizationId !== null) {
      qb.andWhere('e.organizationId = :organizationId', { organizationId });
    }

    if (query.eventType) {
      qb.andWhere('e.eventType = :eventType', { eventType: query.eventType });
    }

    if (query.cursor) {
      const [cursorOccurredAt, cursorId] = decodeCursor(query.cursor);
      qb.andWhere('(e.occurredAt, e.id) < (:cursorOccurredAt, :cursorId)', {
        cursorOccurredAt,
        cursorId,
      });
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);

    return {
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(last.occurredAt, last.id) : null,
    };
  }
}

/** §8.7: the four content topics land here, at `info` (or `warn` for a rejection). */
@Injectable()
export class AuditEventRepository
  extends AuditRecordRepository<AuditEvent>
  implements IAuditEventRepository
{
  protected readonly entityTarget: EntityTarget<AuditEvent> = AuditEvent;
}

/** §8.7, §13.9: `security.events` lands here, always at `security`. */
@Injectable()
export class SecurityEventRepository
  extends AuditRecordRepository<SecurityEvent>
  implements ISecurityEventRepository
{
  protected readonly entityTarget: EntityTarget<SecurityEvent> = SecurityEvent;
}

function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  const [occurredAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return [occurredAt, id];
}
