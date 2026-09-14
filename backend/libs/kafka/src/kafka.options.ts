export const KAFKA_CLIENT = Symbol('KAFKA_CLIENT');

export interface KafkaModuleOptions {
  brokers: string[];
  clientIdPrefix: string;
  serviceName: string;
  groupId: string;
}
