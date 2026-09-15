import { Inject, Injectable } from '@nestjs/common';
import {
  BaseKafkaConsumer,
  CONSUMED_EVENT_STORE,
  KAFKA_CLIENT,
  type ConsumedEventStore,
  type KafkaModuleOptions,
} from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS, type EventEnvelope, type KafkaTopic } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import { TenantAwareDataSource } from '@app/database';
import { UserRole } from '../users/user.entity';
import { USER_REPOSITORY, type IUserRepository } from '../users/user.repository.interface';

interface OrganizationProvisionedPayload {
  organizationId: string;
  adminUserId: string;
  adminEmail: string;
  adminFirstName: string;
  adminLastName: string;
}

/**
 * §8.4 "Consumes": OrganizationProvisioned -> create the first admin user
 * row, with the SAME id auth-service minted for the credential (§11.3) — see
 * user.repository.interface.ts's create() for why `id` is honoured rather
 * than generated.
 *
 * Runs OUTSIDE any HTTP request — BaseKafkaConsumer opens the ALS tenant
 * scope from the envelope before handle() runs (§13.4 "across Kafka"), so
 * TenantAwareDataSource.transaction() inside works exactly as it would for a
 * real request.
 *
 * §17.6: idempotent by construction — BaseKafkaConsumer's consumed_events
 * dedupe means this never runs twice for the same event, so it cannot create
 * two admin users for one onboarding. The unique constraint on
 * (organization_id, email) is a second, independent backstop.
 */
@Injectable()
export class OrganizationProvisionedConsumer extends BaseKafkaConsumer {
  protected readonly topic: KafkaTopic = KAFKA_TOPICS.ORGANIZATION;

  constructor(
    @Inject(KAFKA_CLIENT) options: KafkaModuleOptions,
    tenantContext: TenantContextStore,
    @Inject(CONSUMED_EVENT_STORE) consumedEvents: ConsumedEventStore,
    private readonly tenantDataSource: TenantAwareDataSource,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
  ) {
    super(options, tenantContext, consumedEvents);
  }

  protected async handle(envelope: EventEnvelope): Promise<void> {
    if (envelope.eventType !== EVENT_TYPES.ORGANIZATION_PROVISIONED) return;
    const payload = envelope.payload as OrganizationProvisionedPayload;

    await this.tenantDataSource.transaction((manager) =>
      this.users.create(
        {
          id: payload.adminUserId,
          organizationId: payload.organizationId,
          email: payload.adminEmail,
          firstName: payload.adminFirstName,
          lastName: payload.adminLastName,
          role: UserRole.ORG_ADMIN,
        },
        manager,
      ),
    );
  }
}
