import {
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
} from 'typeorm';

/**
 * Every tenant-owned entity extends this (§15.2, §13.7 row 3's mitigation).
 * organization_id is what the RLS policy filters on and what the §13.8 CI check
 * looks for — extending this class is what registers a table as tenant-owned.
 *
 * Global tables (plans, migrations) do NOT extend this — they are listed in
 * GLOBAL_TABLES instead (see rls-tables.ts).
 */
export abstract class TenantBaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'organization_id' })
  organizationId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}
