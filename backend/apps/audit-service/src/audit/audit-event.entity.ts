import { Entity, Index } from 'typeorm';
import { AuditRecordBaseEntity } from './audit-record-base.entity';

/**
 * §8.7's `audit_events` — every event from the four CONTENT topics
 * (`organization.events`, `user.events`, `subscription.events`,
 * `resource.events`). Security-topic events go to `security_events` instead.
 *
 * Bare `@Entity('audit_events')` with NO `schema:` option, and no `schema:`
 * on this service's DataSource either: audit-service owns `audit_db` outright
 * (§14.1), exactly like auth-service, tenant-service and resource-service, so
 * its tables live in the default `public` schema that Postgres's default
 * search_path ("$user", public) already covers. The `schema: 'users'` /
 * `schema: 'subs'` settings user-service and subscription-service carry exist
 * only because those two share one physical core_db (§14.2, §32.4).
 *
 * §14.4's two indexes for this table are created in the migration:
 * `(organization_id, occurred_at DESC)` for the org-scoped list, and
 * `(correlation_id)` for trace reconstruction. The @Index decorators below
 * mirror them for documentation; `synchronize: false` means the migration is
 * what actually creates them.
 */
@Entity('audit_events')
@Index(['organizationId', 'occurredAt'])
@Index(['correlationId'])
export class AuditEvent extends AuditRecordBaseEntity {}
