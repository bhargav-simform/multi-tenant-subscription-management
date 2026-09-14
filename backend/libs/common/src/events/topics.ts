export const KAFKA_TOPICS = {
  ORGANIZATION: 'organization.events',
  USER: 'user.events',
  SUBSCRIPTION: 'subscription.events',
  RESOURCE: 'resource.events',
  SECURITY: 'security.events',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

export const dlqTopic = (topic: KafkaTopic): string => `${topic}.dlq`;
