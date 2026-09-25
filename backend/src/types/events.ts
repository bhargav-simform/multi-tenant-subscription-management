/**
 * The event catalogue. Formerly Kafka topics between services; now the channels of
 * the in-process event bus (lib/events). Names and payloads are unchanged because
 * they are persisted verbatim into audit_events / security_events.
 */
export const TOPICS = {
  ORGANIZATION: 'organization.events',
  USER: 'user.events',
  SUBSCRIPTION: 'subscription.events',
  RESOURCE: 'resource.events',
  SECURITY: 'security.events',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

export const EVENT_TYPES = {
  // organization.events
  ORGANIZATION_CREATED: 'OrganizationCreated',
  ORGANIZATION_PROVISIONED: 'OrganizationProvisioned',
  ONBOARDING_FAILED: 'OnboardingFailed',
  ORGANIZATION_SUSPENDED: 'OrganizationSuspended',

  // user.events
  USER_CREDENTIALS_CREATED: 'UserCredentialsCreated',
  USER_INVITED: 'UserInvited',
  USER_CREATED: 'UserCreated',
  USER_REMOVED: 'UserRemoved',
  USER_ROLE_CHANGED: 'UserRoleChanged',
  INVITATION_ACCEPTED: 'InvitationAccepted',
  INVITATION_REVOKED: 'InvitationRevoked',
  INVITATION_EXPIRED: 'InvitationExpired',

  // subscription.events
  SUBSCRIPTION_ASSIGNED: 'SubscriptionAssigned',
  SUBSCRIPTION_CHANGED: 'SubscriptionChanged',
  USAGE_UPDATED: 'UsageUpdated',
  PLAN_LIMIT_EXCEEDED: 'PlanLimitExceeded',

  // resource.events
  RESOURCE_CREATED: 'ResourceCreated',
  RESOURCE_DELETED: 'ResourceDeleted',

  // security.events
  CROSS_TENANT_ACCESS_ATTEMPTED: 'CrossTenantAccessAttempted',
  AUTHENTICATION_FAILED: 'AuthenticationFailed',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/** Every event carries this envelope; it is what the audit sinks persist. */
export interface EventEnvelope<TPayload = unknown> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  organizationId: string | null;
  correlationId: string;
  causationId?: string;
  actorUserId: string | null;
  occurredAt: string;
  payload: TPayload;
}

/**
 * What a service hands to publish() AFTER its transaction commits. No eventId or
 * occurredAt — the bus stamps those, so an envelope cannot be built early.
 */
export interface DomainEvent<TPayload = unknown> {
  eventType: EventType;
  organizationId: string | null;
  actorUserId: string | null;
  payload: TPayload;
  causationId?: string;
}
