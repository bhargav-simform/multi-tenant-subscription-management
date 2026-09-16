/**
 * §8.7's `severity` column. Three values only:
 *
 *   - `info`     — an ordinary domain event from one of the four content
 *                  topics (organization/user/subscription/resource).
 *   - `warn`     — an event that represents a REJECTION. Today exactly one
 *                  event type in the §17.3 catalogue qualifies:
 *                  `PlanLimitExceeded`. It is deliberately listed here even
 *                  though NO service currently publishes it as a Kafka message
 *                  (verified by grep across apps/ — the 409 rejection path in
 *                  user-service and resource-service raises
 *                  PlanLimitExceededException and returns synchronously,
 *                  without an accompanying publish). The schema and the
 *                  consumer are ready for it; inventing a publisher here would
 *                  be putting a producer in a pure sink (§8.7 "Publishes:
 *                  nothing").
 *   - `security` — every event on `security.events`. See
 *                  SecurityEventsConsumer for why no further reconciliation
 *                  happens at this end (§13.9: it happens at the source).
 */
export type AuditSeverity = 'info' | 'warn' | 'security';

export const AUDIT_SEVERITIES: readonly AuditSeverity[] = ['info', 'warn', 'security'] as const;
