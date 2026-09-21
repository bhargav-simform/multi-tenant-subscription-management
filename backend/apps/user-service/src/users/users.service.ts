import { randomUUID, createHash } from 'node:crypto';
import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { InvitationAlreadyPendingError } from '../invitations/invitation-already-pending.error';
import { AUTH_CLIENT, type IAuthClient } from '../invitations/clients/auth-client.interface';
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
    @Inject(AUTH_CLIENT) private readonly authClient: IAuthClient,
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

      let invitation;
      try {
        invitation = await this.invitations.create(
          { email: dto.email, role: dto.role, tokenHash, expiresAt },
          manager,
        );
      } catch (err) {
        if (err instanceof InvitationAlreadyPendingError) {
          throw new ConflictException(err.message);
        }
        throw err;
      }
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
   * ORG RESOLUTION BUG THIS METHOD USED TO HAVE: `users.invitations` has
   * FORCE ROW LEVEL SECURITY, so a plain query against it with
   * app.current_org unset — including the unscoped portion of
   * transactionWithDeferredScope BEFORE setScope() runs — returns ZERO ROWS
   * UNCONDITIONALLY, for every token, valid or not (confirmed empirically
   * against a real Postgres container). findPendingByTokenHashForUpdate
   * cannot be the thing that first discovers organizationId, because it is
   * an ordinary RLS-scoped repository method. The fix mirrors
   * findRoleByUserId's exact two-step shape (user.repository.ts): a
   * SECURITY DEFINER function (migration 1700000000005,
   * users.get_invitation_organization_id) returns ONLY organizationId for a
   * token hash, unscoped; every subsequent query is then properly scoped to
   * that value.
   *
   * Credential creation (§11.3: auth-service mints userId, matching the
   * onboarding saga's pattern for the org's first admin) is a REMOTE HTTP
   * call, made BEFORE the locking transaction opens — never inside it. Doing
   * it inside would hold the subscription-row lock for the duration of a
   * network call, exactly what §19.7 exists to avoid. This means a
   * correctly-scoped PEEK first (transactionForOrganization, its lock
   * released at that transaction's own commit) to fetch email/role and reject
   * an early-expired token, THEN the credential call, THEN the real
   * transactionWithDeferredScope that re-validates and re-locks as the actual
   * source of truth.
   *
   * KNOWN GAP, same tradeoff class as §19.7's "Accepted for this POC": if the
   * token is revoked or raced by a second acceptance between resolving
   * organizationId and the locking transaction below, the transaction's
   * findPendingByTokenHashForUpdate throws GoneException AFTER a working
   * credential has already been minted in auth-service — that credential is
   * then orphaned (no `users` row ever created for it). This codebase's
   * established answer to "external call succeeded, later step failed" is
   * forward-recovery via persisted saga state (onboarding.service.ts), never
   * compensating deletes — there is no delete-credential path anywhere in the
   * system. No saga exists here to resume from, so this one case has no
   * forward-recovery story either; accepted as narrow and rare (requires a
   * revoke/second-accept racing the exact same token in a sub-second window)
   * rather than building unprecedented cleanup logic.
   */
  async acceptInvitation(tokenRaw: string, dto: AcceptInvitationDto): Promise<UserResponseDto> {
    const tokenHash = createHash('sha256').update(tokenRaw).digest('hex');

    const organizationId = await this.tenantDataSource.runGlobal(async (manager) => {
      const rows = await manager.query<{ get_invitation_organization_id: string | null }[]>(
        'SELECT users.get_invitation_organization_id($1)',
        [tokenHash],
      );
      return rows[0]?.get_invitation_organization_id ?? null;
    });
    if (!organizationId) {
      throw new GoneException('This invitation has expired or already been used.');
    }

    // A first, correctly RLS-scoped (transactionForOrganization, using the
    // organizationId just resolved) read of the invitation — locked, but the
    // lock is released at THIS transaction's commit, before the credential
    // call below. Resolves email/role and rejects an expired/spent token
    // early; the SECOND, real transaction below re-validates under its own
    // lock as the actual source of truth (never this peek).
    const peeked = await this.tenantDataSource.transactionForOrganization(
      organizationId,
      (manager) => this.invitations.findPendingByTokenHashForUpdate(tokenHash, manager),
    );
    if (!peeked || peeked.expiresAt.getTime() <= Date.now()) {
      throw new GoneException('This invitation has expired or already been used.');
    }

    const { userId } = await this.authClient.createCredentials({
      organizationId,
      email: peeked.email,
      password: dto.password,
    });

    // ONE transaction throughout (transactionWithDeferredScope, §15.3):
    // setScope() runs FIRST, using the SAME organizationId — every query
    // after this point, including findPendingByTokenHashForUpdate, is
    // RLS-scoped exactly as if transaction() had been used from the start.
    // No gap between lookup and lock — a single lock, held for the
    // transaction's full duration.
    const result = await this.tenantDataSource.transactionWithDeferredScope(
      async (manager, setScope) => {
        await setScope(organizationId);

        // §19.8: filtered to accepted_at/revoked_at IS NULL and locked — the
        // real validity check. The peek above only resolved email/role early
        // to avoid holding this lock across the credential-creation network
        // call; it is not itself the authorization decision.
        const invitation = await this.invitations.findPendingByTokenHashForUpdate(
          tokenHash,
          manager,
        );

        if (!invitation || invitation.expiresAt.getTime() <= Date.now()) {
          throw new GoneException('This invitation has expired or already been used.');
        }

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
            id: userId,
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

    await this.tenantDataSource.transaction(async (manager) => {
      // findById is RLS-scoped (§13.5) — it must run inside this SAME scoped
      // transaction, never against the raw DataSource, or FORCE ROW LEVEL
      // SECURITY makes it return null unconditionally (no app.current_org
      // set on that connection at all), not just for a foreign tenant.
      const invitation = await this.invitations.findById(invitationId, manager);
      if (!invitation || invitation.acceptedAt || invitation.revokedAt) {
        throw new NotFoundException();
      }
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

    const updated = await this.tenantDataSource.transaction(async (manager) => {
      // Same reasoning as revokeInvitation: every read/write here must run
      // inside this scoped transaction, not against the raw DataSource.
      const user = await this.users.findById(userId, manager);
      if (!user) throw new NotFoundException();

      if (user.role === UserRole.ORG_ADMIN && role !== UserRole.ORG_ADMIN) {
        const adminCount = await this.users.countActiveAdmins(organizationId, manager);
        if (adminCount <= 1) {
          throw new LastAdminException();
        }
      }

      await this.users.updateRole(userId, role, manager);
      return this.users.findById(userId, manager);
    });

    await this.publishEvent(organizationId, EVENT_TYPES.USER_ROLE_CHANGED, { userId, role });
    return toUserDto(updated!);
  }

  /** Org Admin; frees a seat (§19.4). */
  async removeUser(userId: string): Promise<void> {
    const ctx = this.tenantContext.getOrThrow();
    const organizationId = ctx.organizationId!;

    await this.tenantDataSource.transaction(async (manager) => {
      // Same reasoning as revokeInvitation/updateRole above.
      const user = await this.users.findById(userId, manager);
      if (!user || user.status === UserStatus.REMOVED) {
        throw new NotFoundException();
      }

      if (user.role === UserRole.ORG_ADMIN) {
        const adminCount = await this.users.countActiveAdmins(organizationId, manager);
        if (adminCount <= 1) {
          throw new LastAdminException();
        }
      }

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
