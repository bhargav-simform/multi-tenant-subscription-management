import { Entity, Column } from 'typeorm';
import { TenantBaseEntity } from '@app/database';
import { UserRole } from '../users/user.entity';

/**
 * §8.4, §19.4: RLS-protected. A pending, unexpired invitation holds a seat
 * (D-Q1) — the partial unique index on (organization_id, email) WHERE
 * accepted_at IS NULL (§19.7) prevents a second invite to the same email
 * from holding a second seat for one person; that index is created in the
 * migration, not expressible as a TypeORM @Index with a WHERE clause here.
 */
@Entity('invitations')
export class Invitation extends TenantBaseEntity {
  @Column({ type: 'citext' })
  email!: string;

  @Column({ type: 'enum', enum: UserRole })
  role!: UserRole;

  /** SHA-256 of the raw invitation token — never store the token itself. */
  @Column({ name: 'token_hash', type: 'varchar', length: 64, unique: true })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  /**
   * §19.9: set by the expiry sweep. accepted_at IS NULL AND revoked_at IS NULL
   * AND expires_at <= now() is what the sweep targets; this column records
   * that the sweep (or an admin, via revoke) has already released this seat,
   * so it is not counted or swept again.
   */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
