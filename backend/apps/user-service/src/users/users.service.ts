import { randomUUID, createHash } from 'node:crypto';
import { GoneException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { EventPublisher, type DomainEvent } from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS, PlanLimitExceededException, LastAdminException } from '@app/common';
import { User, UserRole, UserStatus } from './user.entity';
import { USER_REPOSITORY, type IUserRepository } from './user.repository.interface';
import {
  INVITATION_REPOSITORY,
  type IInvitationRepository,
} from '../invitations/invitation.repository.interface';
import {
  SUBSCRIPTION_SEAT_REPOSITORY,
  type ISubscriptionSeatRepository,
} from '../subscriptions/subscription-seat.repository.interface';
import type { InviteUserDto } from './dto/invite-user.dto';
import type { UserResponseDto } from './dto/user-response.dto';
import type { AcceptInvitationDto } from '../invitations/dto/accept-invitation.dto';

const INVITATION_EXPIRY_DAYS = 7; // D-Q7

/**
 * §19: owns the seat-limit transaction. Every method here that changes
 * `used_seats` locks the subscription row FIRST (§19.7 "deadlock" — consistent
 * ordering), inside ONE transaction with its own write, and publishes events
 * only AFTER commit (§17.5). This is the file the brief's sharpest concurrency
 * test (T3) exercises directly.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDataSource: TenantAwareDataSource,
    private readonly tenantContext: TenantContextStore,
    private readonly publisher: EventPublisher,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(INVITATION_REPOSITORY) private readonly invitations: IInvitationRepository,
    @Inject(SUBSCRIPTION_SEAT_REPOSITORY) private readonly seats: ISubscriptionSeatRepository,
  ) {}

  /**
   * §19.2: the seat-limit path. A pending invitation holds a seat (D-Q1) —
   * used_seats is incremented here, at invite time, not at acceptance.
   */
  async invite(dto: InviteUserDto): Promise<{ invitationId: string; tokenForDev: string }> {
    const ctx = this.tenantContext.getOrThrow();
    const organizationId = ctx.organizationId!;

    const rawToken = randomUUID() + randomUUID();
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const invitationId = await this.tenantDataSource.transaction(async (manager) => {
      // §19.7: subscription row locked FIRST, always, for deadlock avoidance.
      const seat = await this.seats.lockForUpdate(organizationId, manager);

      if (seat.usedSeats >= seat.maxSeatsSnapshot) {
        const [activeUsers, pendingInvitations] = await Promise.all([
          this.users.countActive(organizationId, manager),
          this.invitations.countPending(organizationId, manager),
        ]);
        throw new PlanLimitExceededException(
          {
            limitType: 'seats',
            limit: seat.maxSeatsSnapshot,
            current: seat.usedSeats,
            planCode: 'unknown', // subscription-service owns plan metadata; not available here yet
            activeUsers,
            pendingInvitations,
          },
          `Your plan allows ${seat.maxSeatsSnapshot} seats. All ${seat.usedSeats} are held ` +
            `(${activeUsers} users, ${pendingInvitations} pending invitations). ` +
            `Remove a user or revoke a pending invitation before inviting another.`,
        );
      }

      const invitation = await this.invitations.create(
        { email: dto.email, role: dto.role, tokenHash, expiresAt },
        manager,
      );
      await this.seats.adjustUsedSeats(organizationId, 1, manager);
      return invitation.id;
    });

    await this.publishEvent(organizationId, EVENT_TYPES.USER_INVITED, {
      invitationId,
      email: dto.email,
      role: dto.role,
    });

    // D-Q6: email delivery is stubbed for the MVP — the token is returned in
    // the response in development so the invite flow is demonstrable without
    // SMTP. A production build would email this link and never return it here.
    return { invitationId, tokenForDev: rawToken };
  }

  /**
   * §19.8: net-zero on used_seats, but STILL locks the subscription row —
   * without the lock, a sweep could expire this invitation (releasing the
   * seat) between the expiry check and the user insert here, leaving a user
   * occupying a seat the counter no longer counts.
   *
   * ONE transaction throughout (transactionWithDeferredScope, §15.3): the
   * organisation is not known until the token resolves it, so the
   * transaction begins unscoped, looks up the invitation by its token hash
   * (a cryptographically random, single-use value — the token itself IS the
   * authorization to read this one row, §11.5), THEN scopes the rest of the
   * same transaction to that organisation before touching users or
   * subscriptions. No gap between lookup and lock — a single lock, held for
   * the transaction's full duration.
   */
  async acceptInvitation(tokenRaw: string, dto: AcceptInvitationDto): Promise<UserResponseDto> {
    const tokenHash = createHash('sha256').update(tokenRaw).digest('hex');

    const result = await this.tenantDataSource.transactionWithDeferredScope(
      async (manager, setScope) => {
        // §19.8: the same repository method the expiry sweep's counterpart
        // reasoning depends on — locked, and filtered to accepted_at/revoked_at
        // IS NULL. Not tenant-scoped (cannot be — org is unknown until this
        // resolves), which is why this call is unscoped by construction (§11.5:
        // the token itself is the authorization to read this one row).
        const invitation = await this.invitations.findPendingByTokenHashForUpdate(
          tokenHash,
          manager,
        );

        if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
          throw new GoneException('This invitation has expired or already been used.');
        }

        const organizationId = invitation.organizationId;
        await setScope(organizationId);

        // §19.7: EVERY OTHER seat-changing path locks the subscription row
        // FIRST. This one cannot: the organisation — and therefore which
        // subscription row to lock — is not known until the invitation row
        // above is found, and that lookup itself takes a row lock (line 122).
        // This is a DELIBERATE, NARROW EXCEPTION to the "subscription first"
        // ordering, forced by transactionWithDeferredScope's whole reason for
        // existing (§15.3) — not an oversight, and not "consistent" with the
        // other four paths. Consequence: a transaction that holds the
        // subscription lock and then updates invitation rows in the OPPOSITE
        // order (the sweep, §19.9) can deadlock against this one. PostgreSQL
        // detects and aborts one side with error 40P01 rather than hanging;
        // the aborted transaction should be retried by the caller. Accepted
        // for this POC as a rare, narrow, detected-not-silent failure mode —
        // revisit if the sweep and acceptance contend often enough to matter.
        await this.seats.lockForUpdate(organizationId, manager);

        const created = await this.users.create(
          {
            organizationId,
            email: invitation.email,
            firstName: dto.firstName,
            lastName: dto.lastName,
            role: invitation.role,
          },
          manager,
        );
        await this.invitations.markAccepted(invitation.id, manager);
        // used_seats UNCHANGED (§19.8) — the seat was already held by the invitation.

        return { user: created, invitationId: invitation.id, organizationId };
      },
    );

    await this.publishEvent(result.organizationId, EVENT_TYPES.USER_CREATED, {
      userId: result.user.id,
      email: result.user.email,
    });
    await this.publishEvent(result.organizationId, EVENT_TYPES.INVITATION_ACCEPTED, {
      invitationId: result.invitationId,
    });

    return toUserDto(result.user);
  }

  /** Org Admin; revokes a pending invitation and releases its seat (§19.4). */
  async revokeInvitation(invitationId: string): Promise<void> {
    const ctx = this.tenantContext.getOrThrow();
    const organizationId = ctx.organizationId!;

    const invitation = await this.invitations.findById(invitationId);
    if (!invitation || invitation.acceptedAt || invitation.revokedAt) {
      throw new NotFoundException();
    }

    await this.tenantDataSource.transaction(async (manager) => {
      await this.seats.lockForUpdate(organizationId, manager);
      await this.invitations.markRevoked(invitationId, manager);
      await this.seats.adjustUsedSeats(organizationId, -1, manager);
    });

    await this.publishEvent(organizationId, EVENT_TYPES.INVITATION_REVOKED, { invitationId });
  }

  /** Org Admin; cannot demote the last admin. */
  async updateRole(userId: string, role: UserRole): Promise<UserResponseDto> {
    const ctx = this.tenantContext.getOrThrow();
    const organizationId = ctx.organizationId!;

    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException();

    if (user.role === UserRole.ORG_ADMIN && role !== UserRole.ORG_ADMIN) {
      const adminCount = await this.tenantDataSource.transaction((manager) =>
        this.users.countActiveAdmins(organizationId, manager),
      );
      if (adminCount <= 1) {
        throw new LastAdminException();
      }
    }

    await this.users.updateRole(userId, role);
    const updated = await this.users.findById(userId);
    await this.publishEvent(organizationId, EVENT_TYPES.USER_ROLE_CHANGED, { userId, role });
    return toUserDto(updated!);
  }

  /** Org Admin; frees a seat (§19.4). */
  async removeUser(userId: string): Promise<void> {
    const ctx = this.tenantContext.getOrThrow();
    const organizationId = ctx.organizationId!;

    const user = await this.users.findById(userId);
    if (!user || user.status === UserStatus.REMOVED) {
      throw new NotFoundException();
    }

    if (user.role === UserRole.ORG_ADMIN) {
      const adminCount = await this.tenantDataSource.transaction((manager) =>
        this.users.countActiveAdmins(organizationId, manager),
      );
      if (adminCount <= 1) {
        throw new LastAdminException();
      }
    }

    await this.tenantDataSource.transaction(async (manager) => {
      await this.seats.lockForUpdate(organizationId, manager);
      await this.users.markRemoved(userId, manager);
      await this.seats.adjustUsedSeats(organizationId, -1, manager);
    });

    await this.publishEvent(organizationId, EVENT_TYPES.USER_REMOVED, { userId });
  }

  private async publishEvent<T>(
    organizationId: string,
    eventType: (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES],
    payload: T,
  ): Promise<void> {
    const event: DomainEvent<T> = {
      eventType,
      organizationId,
      actorUserId: this.tenantContext.get()?.userId ?? null,
      payload,
    };
    await this.publisher.publish(KAFKA_TOPICS.USER, event);
  }
}

function toUserDto(user: User): UserResponseDto {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    status: user.status,
  };
}
