/**
 * The full event catalogue (§17.3). Every producer/consumer pair in the system
 * references these constants — never a raw string literal.
 */
export const EVENT_TYPES = {
  // organization.events — producer: tenant-service
  ORGANIZATION_CREATED: 'OrganizationCreated',
  ORGANIZATION_PROVISIONED: 'OrganizationProvisioned',
  ONBOARDING_FAILED: 'OnboardingFailed',
  ORGANIZATION_SUSPENDED: 'OrganizationSuspended',

  // user.events — producers: auth-service, user-service
  USER_CREDENTIALS_CREATED: 'UserCredentialsCreated',
  USER_INVITED: 'UserInvited',
  USER_CREATED: 'UserCreated',
  USER_REMOVED: 'UserRemoved',
  USER_ROLE_CHANGED: 'UserRoleChanged',
  INVITATION_ACCEPTED: 'InvitationAccepted',
  INVITATION_REVOKED: 'InvitationRevoked',
  INVITATION_EXPIRED: 'InvitationExpired',

  // subscription.events — producer: subscription-service
  SUBSCRIPTION_ASSIGNED: 'SubscriptionAssigned',
  SUBSCRIPTION_CHANGED: 'SubscriptionChanged',
  USAGE_UPDATED: 'UsageUpdated',
  PLAN_LIMIT_EXCEEDED: 'PlanLimitExceeded',

  // resource.events — producer: resource-service
  RESOURCE_CREATED: 'ResourceCreated',
  RESOURCE_DELETED: 'ResourceDeleted',

  // security.events — producers: any
  CROSS_TENANT_ACCESS_ATTEMPTED: 'CrossTenantAccessAttempted',
  AUTHENTICATION_FAILED: 'AuthenticationFailed',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
