import type { EntityManager } from 'typeorm';
import type { Invitation } from './invitation.entity';
import type { UserRole } from '../users/user.entity';

export const INVITATION_REPOSITORY = Symbol('INVITATION_REPOSITORY');

export interface IInvitationRepository {
  /** §19.2: counted toward used_seats — pending AND unexpired AND unrevoked. */
  countPending(organizationId: string, manager: EntityManager): Promise<number>;
  create(
    data: { email: string; role: UserRole; tokenHash: string; expiresAt: Date },
    manager: EntityManager,
  ): Promise<Invitation>;
  /**
   * §19.8: locked (FOR UPDATE) so acceptance and the expiry sweep cannot race
   * on the same invitation.
   */
  findPendingByTokenHashForUpdate(
    tokenHash: string,
    manager: EntityManager,
  ): Promise<Invitation | null>;
  markAccepted(id: string, manager: EntityManager): Promise<void>;
  findById(id: string, manager: EntityManager): Promise<Invitation | null>;
  markRevoked(id: string, manager: EntityManager): Promise<void>;
  /** §19.9: the sweep's target set. Locks nothing itself — the sweep locks the subscription row. */
  findExpiredIds(organizationId: string, manager: EntityManager): Promise<string[]>;
  markManyExpired(ids: string[], manager: EntityManager): Promise<void>;
}
