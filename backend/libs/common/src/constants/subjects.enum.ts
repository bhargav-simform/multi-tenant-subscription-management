/** CASL subjects (§12.2). Adding one requires updating the ability factory for all three roles. */
export enum Subject {
  ORGANIZATION = 'Organization',
  USER = 'User',
  SUBSCRIPTION = 'Subscription',
  PLAN = 'Plan',
  RESOURCE = 'Resource',
  AUDIT_EVENT = 'AuditEvent',
  ALL = 'all',
}
