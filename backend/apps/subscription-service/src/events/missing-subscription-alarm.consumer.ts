import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { Subscription } from '../subscriptions/subscription.entity';

const SEAT_AFFECTING_EVENTS: string[] = [
  EVENT_TYPES.USER_INVITED,
  EVENT_TYPES.USER_CREATED,
  EVENT_TYPES.USER_REMOVED,
  EVENT_TYPES.INVITATION_ACCEPTED,
  EVENT_TYPES.INVITATION_EXPIRED,
];

/**
 * §8.5 "Consumes", §19.4. NAMED HONESTLY: this is a missing-row alarm, NOT
 * drift detection. It confirms a subscription row exists whenever a
 * seat-affecting event arrives for an organisation, and logs a
 * security-severity line if it doesn't (evidence of a code path that
 * skipped onboarding's invariant that every org gets exactly one row).
 *
 * §19.4's "Drift detection" describes something stronger this consumer does
 * NOT do: comparing the STORED `used_seats` against a freshly recomputed
 * count of active users + pending invitations. Building that here would
 * require subscription-service to read `users.users`/`users.invitations`
 * directly — technically possible (app_user's grants cover the whole
 * `users` schema, since both services share one role in `core_db`, §14.2),
 * but exactly the cross-schema violation §14.2 forbids ("neither service
 * reads the other's tables for ordinary queries"). Real drift detection
 * needs one of:
 *   (a) user-service publishes its own computed seat count in each
 *       seat-affecting event's payload, and this consumer compares it
 *       against `used_seats` — the comparison stays here, the count stays
 *       computed by the service that owns the source tables; or
 *   (b) a scheduled job INSIDE user-service (which already owns both
 *       `used_seats` and the tables that would recompute it), publishing a
 *       discrepancy event this service could alert on.
 * Neither is built yet — tracked in ARCHITECTURE.md §32.3, not silently
 * assumed to be covered by this class's presence. This consumer NEVER
 * writes `used_seats` either way — user-service is the sole writer, inside
 * the locked transaction that changes it (§19.4).
 */
@Injectable()
export class MissingSubscriptionAlarmConsumer extends BaseKafkaConsumer {
  protected readonly topic: KafkaTopic = KAFKA_TOPICS.USER;
  private readonly alarmLogger = new Logger(MissingSubscriptionAlarmConsumer.name);

  constructor(
    @Inject(KAFKA_CLIENT) options: KafkaModuleOptions,
    tenantContext: TenantContextStore,
    @Inject(CONSUMED_EVENT_STORE) consumedEvents: ConsumedEventStore,
    private readonly tenantDataSource: TenantAwareDataSource,
  ) {
    super(options, tenantContext, consumedEvents);
  }

  protected async handle(envelope: EventEnvelope): Promise<void> {
    if (!SEAT_AFFECTING_EVENTS.includes(envelope.eventType)) return;
    if (!envelope.organizationId) return;

    const organizationId = envelope.organizationId;
    const exists = await this.tenantDataSource.transactionForOrganization(
      organizationId,
      (manager) => manager.getRepository(Subscription).exists({ where: { organizationId } }),
    );

    if (!exists) {
      this.alarmLogger.error(
        `security: seat-affecting event ${envelope.eventType} for organization ${organizationId} ` +
          `with NO subscription row — evidence of a code path that skipped onboarding's invariant`,
      );
    }
  }
}
