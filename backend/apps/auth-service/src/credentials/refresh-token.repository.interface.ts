import type { EntityManager } from 'typeorm';
import type { RefreshToken } from './refresh-token.entity';

export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');

export interface IRefreshTokenRepository {
  findByTokenHash(tokenHash: string, manager?: EntityManager): Promise<RefreshToken | null>;
  create(
    data: { credentialId: string; tokenHash: string; expiresAt: Date },
    manager: EntityManager,
  ): Promise<RefreshToken>;
  /** §11.4: marks the presented token as rotated-away in favour of its successor. */
  markReplaced(id: string, replacedById: string, manager: EntityManager): Promise<void>;
  /**
   * §11.4: "presenting an already-replaced token is treated as theft — the
   * whole token family is revoked". Revokes every non-revoked token for this
   * credential, not just the reused one, since the whole chain is now suspect.
   */
  revokeAllForCredential(credentialId: string, manager: EntityManager): Promise<void>;
  revoke(id: string, manager?: EntityManager): Promise<void>;
}
