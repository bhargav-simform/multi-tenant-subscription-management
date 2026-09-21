import { Injectable } from '@nestjs/common';
import { EntityManager, IsNull, LessThanOrEqual, MoreThan, In, QueryFailedError } from 'typeorm';
import { TenantContextStore } from '@app/tenant-context';
import { TenantRepository } from '@app/database';
import { Invitation } from './invitation.entity';
import type { UserRole } from '../users/user.entity';
import type { IInvitationRepository } from './invitation.repository.interface';
import { InvitationAlreadyPendingError } from './invitation-already-pending.error';

/** PostgreSQL's error code for a unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * §32.4: every method takes a REQUIRED `manager` from a
 * TenantAwareDataSource-scoped transaction — no fallback to a raw, unscoped
 * DataSource, so a caller that forgets to scope a query fails at the type
 * level rather than silently returning nothing under FORCE ROW LEVEL SECURITY.
 */
@Injectable()
export class InvitationRepository
  extends TenantRepository<Invitation>
  implements IInvitationRepository
{
  protected readonly entityTarget = Invitation;

  constructor(tenantContext: TenantContextStore) {
    super(tenantContext);
  }

  /**
   * §19.4: only unexpired invitations hold a seat (D-Q1). An
   * expired-but-not-yet-swept invitation does NOT count — the sweep just
   * hasn't run yet. Without the expiresAt filter, a stalled sweep would make
   * this figure (used only for the §19.5 rejection message's breakdown, not
   * the enforcement decision itself — that reads used_seats directly under
   * the lock) claim the org is permanently over capacity even after seats
   * are effectively free.
   */
  async countPending(organizationId: string, manager: EntityManager): Promise<number> {
    return manager.getRepository(Invitation).count({
      where: {
        organizationId,
        acceptedAt: IsNull(),
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
  }

  /**
   * No findPendingByEmail() check-then-write here — that shape is a TOCTOU
   * race under concurrent invites for the same email. The partial unique
   * index `uq_invitations_org_email_pending` is the real guarantee; a
   * violation is caught and translated to a typed error the caller can
   * distinguish from any other database failure.
   */
  async create(
    data: { email: string; role: UserRole; tokenHash: string; expiresAt: Date },
    manager: EntityManager,
  ): Promise<Invitation> {
    const repo = manager.getRepository(Invitation);
    const invitation = repo.create({ ...data, organizationId: this.organizationId });
    try {
      return await repo.save(invitation);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new InvitationAlreadyPendingError(data.email);
      }
      throw err;
    }
  }

  async listPending(organizationId: string, manager: EntityManager): Promise<Invitation[]> {
    return manager.getRepository(Invitation).find({
      where: {
        organizationId,
        acceptedAt: IsNull(),
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
      order: { createdAt: 'DESC' },
    });
  }

  async findPendingByTokenHashForUpdate(
    tokenHash: string,
    manager: EntityManager,
  ): Promise<Invitation | null> {
    return manager
      .getRepository(Invitation)
      .createQueryBuilder('i')
      .setLock('pessimistic_write')
      .where('i.tokenHash = :tokenHash', { tokenHash })
      .andWhere('i.acceptedAt IS NULL')
      .andWhere('i.revokedAt IS NULL')
      .getOne();
  }

  async markAccepted(id: string, manager: EntityManager): Promise<void> {
    await manager.getRepository(Invitation).update({ id }, { acceptedAt: new Date() });
  }

  async findById(id: string, manager: EntityManager): Promise<Invitation | null> {
    return manager
      .getRepository(Invitation)
      .findOne({ where: { id, organizationId: this.organizationId } });
  }

  async markRevoked(id: string, manager: EntityManager): Promise<void> {
    await manager
      .getRepository(Invitation)
      .update({ id, organizationId: this.organizationId }, { revokedAt: new Date() });
  }

  async findExpiredIds(organizationId: string, manager: EntityManager): Promise<string[]> {
    const rows = await manager.getRepository(Invitation).find({
      select: { id: true },
      where: {
        organizationId,
        acceptedAt: IsNull(),
        revokedAt: IsNull(),
        expiresAt: LessThanOrEqual(new Date()),
      },
    });
    return rows.map((r) => r.id);
  }

  async markManyExpired(ids: string[], manager: EntityManager): Promise<void> {
    if (ids.length === 0) return;
    // §19.9: the sweep marks expiry via revokedAt — a swept invitation and an
    // admin-revoked one are indistinguishable by column, which is correct:
    // both mean "this pending invite no longer holds a seat", and the
    // published event (InvitationExpired) is what records WHICH happened.
    await manager.getRepository(Invitation).update({ id: In(ids) }, { revokedAt: new Date() });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
