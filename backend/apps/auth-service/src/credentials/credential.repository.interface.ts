import type { EntityManager } from 'typeorm';
import type { Credential } from './credential.entity';

export const CREDENTIAL_REPOSITORY = Symbol('CREDENTIAL_REPOSITORY');

/**
 * §20.2: application services depend on this interface, never on
 * Repository<Credential> directly. Not a TenantRepository — see
 * credential.entity.ts for why this table has no RLS to apply.
 */
export interface ICredentialRepository {
  findByEmail(email: string, manager?: EntityManager): Promise<Credential | null>;
  findByUserId(userId: string, manager?: EntityManager): Promise<Credential | null>;
  /** By this row's OWN id — distinct from userId. Used by refresh() via refresh_tokens.credential_id. */
  findById(id: string, manager?: EntityManager): Promise<Credential | null>;
  /**
   * Relies on the unique constraint on `email` (§15.5/§16.4 pattern, same as
   * OrganizationRepository.create()) — never a check-then-write race.
   */
  create(
    data: { userId: string; organizationId: string | null; email: string; passwordHash: string },
    manager: EntityManager,
  ): Promise<Credential>;
}
