import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { TenantAwareDataSource } from '@app/database';
import { EventPublisher, type DomainEvent } from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS } from '@app/common';
import { SubscriptionSeatView } from '../subscriptions/subscription.entity';
import {
  INVITATION_REPOSITORY,
  type IInvitationRepository,
} from '../invitations/invitation.repository.interface';
import {
  SUBSCRIPTION_SEAT_REPOSITORY,
  type ISubscriptionSeatRepository,
} from '../subscriptions/subscription-seat.repository.interface';

/**
 * §19.9: the ONE background job in the system. Iterates organisations via
 * runGlobal() (§13.6's documented, auditable exception — not an RLS bypass on
 * any tenant table, since it only reads the tenant-service-owned org list
 * mirror; see organization.entity.ts), then opens a NORMAL per-org scoped
 * transaction for the actual work, taking the SAME subscription-row lock the
 * invite path takes — a sweep and an invite cannot race (§19.4).
 *
 * Conservative under failure (§30.2): if this stalls, seats stay held. An org
 * may see a 409 while genuinely under its cap — a degraded experience, never
 * a breached limit.
 */
@Injectable()
export class InvitationExpirySweepService {
  private readonly logger = new Logger(InvitationExpirySweepService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantDataSource: TenantAwareDataSource,
    private readonly publisher: EventPublisher,
    @Inject(INVITATION_REPOSITORY) private readonly invitations: IInvitationRepository,
    @Inject(SUBSCRIPTION_SEAT_REPOSITORY) private readonly seats: ISubscriptionSeatRepository,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async run(): Promise<void> {
    // §14.2: every organisation gets exactly one subs.subscriptions row
    // during onboarding, and that table lives in core_db — the same
    // physical database user-service already connects to. No cross-database
    // or cross-service call is needed to enumerate organisations for the
    // sweep; the alternative (calling tenant-service's org list over HTTP)
    // would add a network dependency to a background job for information
    // this service already has local, narrow-grant access to (§14.2's one
    // documented cross-schema grant).
    const rows = await this.tenantDataSource.runGlobal((manager) =>
      manager
        .getRepository(SubscriptionSeatView)
        .createQueryBuilder('sub')
        .select('sub.organizationId', 'organizationId')
        .getRawMany<{ organizationId: string }>(),
    );
    const organizationIds = rows.map((r) => r.organizationId);

    for (const organizationId of organizationIds) {
      await this.sweepOrganization(organizationId);
    }
  }

  private async sweepOrganization(organizationId: string): Promise<void> {
    let expiredIds: string[];

    try {
      expiredIds = await this.tenantDataSource.transactionForOrganization(
        organizationId,
        async (manager) => {
          // §19.7: subscription row locked first — same lock the invite path
          // takes, so a sweep and an invite for the same org cannot race.
          await this.seats.lockForUpdate(organizationId, manager);

          const ids = await this.invitations.findExpiredIds(organizationId, manager);
          if (ids.length === 0) return [];

          await this.invitations.markManyExpired(ids, manager);
          await this.seats.adjustUsedSeats(organizationId, -ids.length, manager);
          return ids;
        },
      );
    } catch (err) {
      // §30.2: a failed sweep for one org must not stop the sweep for others,
      // and must not throw seats out of sync — the transaction rolled back,
      // so nothing was half-applied.
      this.logger.error(
        `Invitation sweep failed for organization ${organizationId}: ${(err as Error).message}`,
      );
      return;
    }

    for (const invitationId of expiredIds) {
      await this.publishEvent(organizationId, EVENT_TYPES.INVITATION_EXPIRED, { invitationId });
    }
  }

  private async publishEvent<T>(
    organizationId: string,
    eventType: (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES],
    payload: T,
  ): Promise<void> {
    const event: DomainEvent<T> = { eventType, organizationId, actorUserId: null, payload };
    await this.publisher.publish(KAFKA_TOPICS.USER, event);
  }
}
