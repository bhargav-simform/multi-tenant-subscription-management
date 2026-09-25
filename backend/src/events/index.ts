import * as auditSink from './handlers/audit-sink.handler';
import * as missingSubscriptionAlarm from './handlers/missing-subscription-alarm.handler';
import * as organizationProvisioned from './handlers/organization-provisioned.handler';
import * as planLimitSync from './handlers/plan-limit-sync.handler';
import * as securityEvents from './handlers/security-events.handler';
import * as storageReconciliation from './handlers/storage-reconciliation.handler';

let registered = false;

/**
 * Wires every former Kafka consumer to the in-process bus. Domain handlers first,
 * the audit sinks last, so an audit row is written after the effect it records.
 * Idempotent, so tests and server.ts can both call it.
 */
export function registerEventHandlers(): void {
  if (registered) return;
  registered = true;
  organizationProvisioned.register();
  planLimitSync.register();
  storageReconciliation.register();
  missingSubscriptionAlarm.register();
  auditSink.register();
  securityEvents.register();
}
