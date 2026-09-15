import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';
import { bigintTransformer } from '@app/database';

export enum PlanCode {
  FREE = 'free',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

/**
 * §8.5, §14.3: GLOBAL table — a plan catalogue, not tenant data. No RLS, no
 * organization_id. Registered in GLOBAL_TABLES (table-registry.ts), not
 * TENANT_TABLES.
 */
@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: PlanCode, unique: true })
  code!: PlanCode;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ name: 'max_users', type: 'int' })
  maxUsers!: number;

  @Column({ name: 'max_storage_bytes', type: 'bigint', transformer: bigintTransformer })
  maxStorageBytes!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}
