import { Entity, Index } from 'typeorm';
import { AuditRecordBaseEntity } from './audit-record-base.entity';

/**
 * §8.7's `security_events` — "same shape, narrowed to cross-tenant attempts
 * and auth failures". Exactly the two event types on `security.events` in the
 * §17.3 catalogue (`CrossTenantAccessAttempted`, `AuthenticationFailed`);
 * every row here has `severity = 'security'`.
 *
 * THIS TABLE IS THE PRODUCTION TENANT-LEAK DETECTOR (§13.9, §26). A query
 * grouping by `actor_user_id` over a time window surfaces a probing user
 * immediately — which is why `(organization_id, occurred_at DESC)` leads the
 * index here as it does on `audit_events`, and why a platform admin gets FULL
 * rows from `GET /audit/security` rather than the metadata projection
 * `GET /audit` applies (§8.7): a security event's payload is
 * `{subjectType, subjectId, actorOrganizationId, actorUserId}` by construction
 * — see resource-service's and user-service's `reportIfCrossTenantAttempt`,
 * and auth-service's `publishAuthFailure` (`{email, reason}`) — so it never
 * carries arbitrary organisation content the way a `ResourceCreated` payload
 * does. Withholding it would blind the detector for no isolation gain.
 */
@Entity('security_events')
@Index(['organizationId', 'occurredAt'])
@Index(['correlationId'])
export class SecurityEvent extends AuditRecordBaseEntity {}
