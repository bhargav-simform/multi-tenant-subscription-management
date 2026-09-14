import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Credential } from './credential.entity';

/**
 * §11.4: single-use rotation. `replacedBy` chains a token to the one that
 * superseded it — presenting an already-replaced token means the WHOLE CHAIN
 * is compromised (theft), not just this one token, so revocation walks the
 * chain forward from the reused token (§11.4 "the whole token family is
 * revoked").
 */
@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'credential_id', type: 'uuid' })
  credentialId!: string;

  @ManyToOne(() => Credential, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'credential_id' })
  credential?: Credential;

  /** SHA-256 of the raw refresh token — never store the token itself. */
  @Column({ name: 'token_hash', type: 'varchar', length: 64, unique: true })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'replaced_by', type: 'uuid', nullable: true })
  replacedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
