import { Entity, Column, Index } from 'typeorm';
import { TenantBaseEntity } from '@app/database';

export enum UserRole {
  ORG_ADMIN = 'org_admin',
  ORG_MEMBER = 'org_member',
}

export enum UserStatus {
  ACTIVE = 'active',
  REMOVED = 'removed',
}

/**
 * §8.4: RLS-protected (§13.5). Extends TenantBaseEntity, so organization_id,
 * RLS policy, and index shape all follow the standard pattern (§13, §14.4).
 *
 * §19.4: an ACTIVE user holds one seat. A REMOVED user does not — DELETE
 * /users/:id sets status to REMOVED rather than hard-deleting (the seat
 * count reads status <> 'removed', §19.2), so the row survives for audit.
 */
@Entity('users')
@Index(['organizationId', 'email'], { unique: true })
export class User extends TenantBaseEntity {
  @Column({ type: 'citext' })
  email!: string;

  @Column({ name: 'first_name', type: 'varchar', length: 255 })
  firstName!: string;

  @Column({ name: 'last_name', type: 'varchar', length: 255 })
  lastName!: string;

  @Column({ type: 'enum', enum: UserRole })
  role!: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })
  status!: UserStatus;
}
