import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IdempotencyService } from '@app/redis';
import { EventPublisher, type DomainEvent } from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS } from '@app/common';
import { OrganizationStatus } from '../organizations/organization.entity';
import {
  ORGANIZATION_REPOSITORY,
  type IOrganizationRepository,
} from '../organizations/organization.repository.interface';
import { OrganizationSlugTakenError } from '../organizations/organization-slug-taken.error';
import { SagaState, type OnboardingSaga } from './onboarding-saga.entity';
import {
  ONBOARDING_SAGA_REPOSITORY,
  type IOnboardingSagaRepository,
} from './onboarding-saga.repository';
import { AUTH_CLIENT, type IAuthClient } from './auth-client.interface';
import { SUBSCRIPTION_CLIENT, type ISubscriptionClient } from './subscription-client.interface';
import type { SignupDto } from './dto/signup.dto';
import type { SignupResponseDto } from './dto/signup-response.dto';

/**
 * §30.1: the self-service onboarding saga. Forward-recovery, not compensation —
 * a failed step leaves `saga.state` at the LAST STEP THAT SUCCEEDED (never
 * overwritten to a "failed" value — see onboarding-saga.entity.ts) and resumes
 * from there on retry, rather than deleting a partial organisation (which would
 * race a concurrent retry and destroy the evidence of what failed).
 *
 * Each step is synchronous REST (§9.2) because the saga must confirm success
 * before advancing — this is NOT a place for Kafka (§17.4: onboarding saga steps
 * stay REST). Events are published only AFTER the relevant step's local
 * transaction commits (§17.5).
 */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly idempotency: IdempotencyService,
    private readonly publisher: EventPublisher,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: IOrganizationRepository,
    @Inject(ONBOARDING_SAGA_REPOSITORY) private readonly sagas: IOnboardingSagaRepository,
    @Inject(AUTH_CLIENT) private readonly authClient: IAuthClient,
    @Inject(SUBSCRIPTION_CLIENT) private readonly subscriptionClient: ISubscriptionClient,
  ) {}

  async signup(dto: SignupDto): Promise<SignupResponseDto> {
    // Redis fast path (§16.2 use #3); the unique constraint on idempotency_key is
    // the real guarantee if Redis is unavailable (§16.4).
    const claimed = await this.idempotency.claim(`onboarding:${dto.idempotencyKey}`);
    if (!claimed) {
      this.logger.debug(`Idempotency key ${dto.idempotencyKey} already claimed, resuming saga`);
    }

    let saga = await this.sagas.findByIdempotencyKey(dto.idempotencyKey);

    if (!saga) {
      saga = await this.dataSource.transaction((manager) =>
        this.sagas.create(
          { idempotencyKey: dto.idempotencyKey, adminEmail: dto.adminEmail },
          manager,
        ),
      );
    }

    if (saga.state === SagaState.COMPLETE) {
      const org = await this.organizations.findById(saga.organizationId!);
      return this.toResponse(org!);
    }

    return this.resume(saga, dto);
  }

  /**
   * Resumes from whatever state the saga last successfully reached — including
   * a saga recovering from a prior failure, since `state` is never touched by
   * a failed attempt (§30.1, onboarding-saga.entity.ts). Each branch falls
   * through to the next on success, so a saga that failed partway through
   * credential creation (state still ORG_CREATED) resumes at credential
   * creation without re-creating the organisation.
   */
  private async resume(saga: OnboardingSaga, dto: SignupDto): Promise<SignupResponseDto> {
    let organizationId = saga.organizationId;

    try {
      if (saga.state === SagaState.PENDING) {
        organizationId = await this.createOrganization(saga.id, dto);
        saga = { ...saga, state: SagaState.ORG_CREATED, organizationId };
      }

      if (saga.state === SagaState.ORG_CREATED) {
        const adminUserId = await this.createAdminCredentials(saga.id, organizationId!, dto);
        saga = { ...saga, state: SagaState.CREDENTIALS_CREATED, adminUserId };
      }

      if (saga.state === SagaState.CREDENTIALS_CREATED) {
        await this.assignDefaultPlan(saga.id, organizationId!);
        saga = { ...saga, state: SagaState.SUBSCRIBED };
      }

      if (saga.state === SagaState.SUBSCRIBED) {
        // saga.adminUserId reflects the DB row at fetch time (or the value
        // just set above), so this is correct whether this call is
        // completing a saga in one pass or resuming one that already
        // reached CREDENTIALS_CREATED in a prior, failed attempt.
        await this.completeOnboarding(saga.id, organizationId!, saga.adminUserId!, dto);
      }

      const org = await this.organizations.findById(organizationId!);
      return this.toResponse(org!);
    } catch (err) {
      if (err instanceof OrganizationSlugTakenError) {
        // Not a saga failure — a genuine naming conflict with another
        // organisation. Nothing was created; no saga state to preserve.
        throw new ConflictException(err.message);
      }
      await this.markFailed(saga.id, organizationId, (err as Error).message);
      throw new ConflictException({
        statusCode: 409,
        error: 'ONBOARDING_INCOMPLETE',
        message:
          'Onboarding could not complete. Retry with the same request — it will resume from where it left off.',
      });
    }
  }

  private async createOrganization(sagaId: string, dto: SignupDto): Promise<string> {
    const slug = slugify(dto.organizationName);

    // §15.5/§16.4: the unique constraint on `slug`, enforced inside
    // OrganizationRepository.create(), is the real guarantee — no
    // check-then-write race here (a prior findBySlug() read would let two
    // concurrent signups for the same name both pass the check).
    const organizationId = await this.dataSource.transaction(async (manager) => {
      const org = await this.organizations.create(
        { name: dto.organizationName, slug },
        manager,
      );
      await this.sagas.advance(
        sagaId,
        SagaState.ORG_CREATED,
        { organizationId: org.id },
        manager,
      );
      return org.id;
    });

    await this.publishEvent(organizationId, EVENT_TYPES.ORGANIZATION_CREATED, {
      organizationId,
      name: dto.organizationName,
    });

    return organizationId;
  }

  private async createAdminCredentials(
    sagaId: string,
    organizationId: string,
    dto: SignupDto,
  ): Promise<string> {
    // §11.3: auth-service mints userId and returns it. It is persisted on the
    // saga row here so COMPLETE can carry it forward into
    // OrganizationProvisioned — user-service's consumer creates the first
    // admin user with this SAME id, never a fresh one.
    const { userId } = await this.authClient.createCredentials({
      organizationId,
      email: dto.adminEmail,
      password: dto.adminPassword,
    });
    await this.dataSource.transaction((manager) =>
      this.sagas.advance(
        sagaId,
        SagaState.CREDENTIALS_CREATED,
        { adminUserId: userId },
        manager,
      ),
    );
    return userId;
  }

  private async assignDefaultPlan(sagaId: string, organizationId: string): Promise<void> {
    await this.subscriptionClient.assignDefaultPlan(organizationId);
    await this.dataSource.transaction((manager) =>
      this.sagas.advance(sagaId, SagaState.SUBSCRIBED, {}, manager),
    );
  }

  private async completeOnboarding(
    sagaId: string,
    organizationId: string,
    adminUserId: string,
    dto: SignupDto,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.organizations.updateStatus(organizationId, OrganizationStatus.ACTIVE, manager);
      await this.sagas.advance(sagaId, SagaState.COMPLETE, {}, manager);
    });
    // §30.1: this is the moment the org becomes loggable-into — user-service
    // creates the first admin user reacting to this event (§8.4 consumes),
    // using the SAME id auth-service minted for the credential (§11.3).
    await this.publishEvent(organizationId, EVENT_TYPES.ORGANIZATION_PROVISIONED, {
      organizationId,
      adminUserId,
      adminEmail: dto.adminEmail,
      adminFirstName: dto.adminFirstName,
      adminLastName: dto.adminLastName,
    });
  }

  /**
   * §30.1: records the failure WITHOUT moving `state` backward or to a
   * terminal "failed" value — see onboarding-saga.entity.ts. Also marks the
   * organisation `provisioning_failed` (§30.1: "the org becomes
   * provisioning_failed") so it is visibly stuck rather than indistinguishable
   * from one still mid-flight — but only if an organisation actually exists
   * yet (a failure during the very first step has none to mark).
   */
  private async markFailed(
    sagaId: string,
    organizationId: string | null,
    error: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.sagas.markFailed(sagaId, error, manager);
      if (organizationId) {
        await this.organizations.updateStatus(
          organizationId,
          OrganizationStatus.PROVISIONING_FAILED,
          manager,
        );
      }
    });
    this.logger.warn(`Onboarding saga ${sagaId} failed: ${error}`);
    // §26.3: onboarding is one of the three mandated structured traces.
    // organizationId is included whenever known so this event lands on the
    // same Kafka partition as the rest of that tenant's onboarding events
    // (§17.2) rather than the platform-wide partition.
    await this.publishEvent(organizationId, EVENT_TYPES.ONBOARDING_FAILED, {
      sagaId,
      organizationId,
      error,
    });
  }

  private async publishEvent<T>(
    organizationId: string | null,
    eventType: (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES],
    payload: T,
  ): Promise<void> {
    const event: DomainEvent<T> = {
      eventType,
      organizationId,
      actorUserId: null,
      payload,
    };
    await this.publisher.publish(KAFKA_TOPICS.ORGANIZATION, event);
  }

  private toResponse(org: { id: string; name: string; status: string }): SignupResponseDto {
    return { organizationId: org.id, organizationName: org.name, status: org.status };
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}
