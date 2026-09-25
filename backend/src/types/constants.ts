/**
 * The three roles this system knows about. A PLATFORM_ADMIN's JWT carries
 * organizationId = null — that null is what makes every RLS policy evaluate false
 * for them, so they structurally cannot read tenant content.
 */
export enum Role {
  PLATFORM_ADMIN = 'platform_admin',
  ORG_ADMIN = 'org_admin',
  ORG_MEMBER = 'org_member',
}

/** CASL actions. Never pass raw strings to authorize(). */
export enum Action {
  CREATE = 'create',
  READ = 'read',
  UPDATE = 'update',
  DELETE = 'delete',
  MANAGE = 'manage',
}

/** CASL subjects. Adding one requires updating the ability factory for all three roles. */
export enum Subject {
  ORGANIZATION = 'Organization',
  USER = 'User',
  SUBSCRIPTION = 'Subscription',
  PLAN = 'Plan',
  RESOURCE = 'Resource',
  AUDIT_EVENT = 'AuditEvent',
  ALL = 'all',
}

export const CORRELATION_ID_HEADER = 'x-correlation-id';
