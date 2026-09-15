import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * §30.1: the forward-recovery state machine for self-service onboarding.
 *
 *   PENDING -> ORG_CREATED -> CREDENTIALS_CREATED -> SUBSCRIBED -> COMPLETE
 *
 * `state` ALWAYS holds the last step that actually succeeded — it is NEVER
 * overwritten with a "failed" value. A failure sets `failedAt` + `lastError`
 * alongside whatever `state` already is, so a retry's resume logic (which
 * switches on `state`) keeps working unchanged whether the saga is mid-flight
 * or recovering from a crash. This is what "the saga records the state
 * reached" (§30.1) means literally: the state IS the reached step, always.
 *
 * idempotency_key is unique so a double-submitted signup (or a client retry
 * after a timeout) resumes the existing saga instead of creating a second
 * organisation (§16.2 use #3 — Redis is the fast path, this constraint is the
 * real guarantee per §16.4).
 */
export enum SagaState {
  PENDING = 'pending',
  ORG_CREATED = 'org_created',
  CREDENTIALS_CREATED = 'credentials_created',
  SUBSCRIBED = 'subscribed',
  COMPLETE = 'complete',
}

@Entity('onboarding_sagas')
export class OnboardingSaga {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255, unique: true })
  idempotencyKey!: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId!: string | null;

  @Column({ type: 'enum', enum: SagaState, default: SagaState.PENDING })
  state!: SagaState;

  @Column({ name: 'admin_email', type: 'varchar', length: 255 })
  adminEmail!: string;

  /**
   * §11.3: set once CREDENTIALS_CREATED succeeds — the userId auth-service
   * minted for this admin. Carried forward to COMPLETE so
   * ORGANIZATION_PROVISIONED's payload lets user-service create its row with
   * the SAME id credentials.user_id already points to.
   */
  @Column({ name: 'admin_user_id', type: 'uuid', nullable: true })
  adminUserId!: string | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  /**
   * Set on any failed attempt, cleared on the next successful advance. A saga
   * with failedAt !== null and state !== COMPLETE is "stuck at state" — this
   * is the field the org's OrganizationStatus.PROVISIONING_FAILED mirrors.
   */
  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
