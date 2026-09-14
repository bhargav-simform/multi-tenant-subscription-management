import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum CredentialStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
}

/**
 * §8.2: credentials are a distinct security boundary from profile data. This
 * table is the only place a password hash exists anywhere in the system.
 *
 * organizationId is nullable — platform admins have none (§11.3). This table
 * is NOT extending TenantBaseEntity: auth_db has no RLS at all (§14.1, own
 * database, single service, no cross-tenant query surface — a credential row
 * is looked up by email or by userId, never listed per-organisation), so there
 * is no tenant scope to structurally enforce here. The isolation guarantee
 * this table participates in is upstream of RLS: it is where organizationId
 * ENTERS the system as a JWT claim (§11.3).
 */
@Entity('credentials')
export class Credential {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId!: string | null;

  @Column({ type: 'citext', unique: true })
  email!: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({ type: 'enum', enum: CredentialStatus, default: CredentialStatus.ACTIVE })
  status!: CredentialStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
