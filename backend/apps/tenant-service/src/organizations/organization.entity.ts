import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum OrganizationStatus {
  PROVISIONING = 'provisioning',
  ACTIVE = 'active',
  PROVISIONING_FAILED = 'provisioning_failed',
  SUSPENDED = 'suspended',
}

/**
 * §8.3: the isolation root — NOT extending TenantBaseEntity and NOT RLS-protected.
 * This is the tenant registry itself, not tenant content. Platform admins read
 * this table directly (metadata only: name, slug, status — no content ever lives
 * here), which is what makes §13.6's "platform admin sees org list but no
 * content" claim true by construction rather than by convention.
 *
 * status = 'provisioning' means the org cannot be logged into yet (§30.1) — a
 * half-onboarded organisation is never usable.
 */
@Entity('organizations')
export class Organization {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  slug!: string;

  @Column({ type: 'enum', enum: OrganizationStatus, default: OrganizationStatus.PROVISIONING })
  status!: OrganizationStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
