import type { SignupDto } from '../dtos/onboarding.dto';
import { publish } from '../lib/events';
import { ConflictException, HttpException } from '../lib/http-errors';
import { createLogger } from '../lib/logger';
import { getPrisma } from '../lib/prisma';
import { runGlobal } from '../lib/tenant-db';
import * as sagas from '../models/onboarding-saga.model';
import { SagaState, type OnboardingSaga } from '../models/onboarding-saga.model';
import * as organizations from '../models/organization.model';
import { OrganizationSlugTakenError, type Organization } from '../models/organization.model';
import { EVENT_TYPES, TOPICS, type EventType } from '../types/events';
import * as credentialsService from './credentials.service';
import * as subscriptions from './subscriptions.service';

const logger = createLogger('OnboardingService');

/**
 * The self-service onboarding saga. Forward recovery, not compensation: a failed
 * step leaves `saga.state` at the last step that succeeded and a retry with the same
 * idempotency key resumes from there, rather than deleting a partial organisation.
 * Events are published only after the step's own transaction commits.
 */
export async function signup(dto: SignupDto): Promise<Organization> {
  let saga = await sagas.findByIdempotencyKey(getPrisma(), dto.idempotencyKey);

  if (saga) {
    logger.debug(`Idempotency key ${dto.idempotencyKey} already used, resuming saga`);
  } else {
    saga = await runGlobal((tx) =>
      sagas.create(tx, { idempotencyKey: dto.idempotencyKey, adminEmail: dto.adminEmail }),
    );
  }

  if (saga.state === SagaState.COMPLETE) {
    return (await organizations.findById(getPrisma(), saga.organizationId!))!;
  }

  return resume(saga, dto);
}

/**
 * Each branch falls through to the next on success, so a saga that failed at
 * credential creation (state still org_created) resumes there without
 * re-creating the organisation.
 */
async function resume(saga: OnboardingSaga, dto: SignupDto): Promise<Organization> {
  let organizationId = saga.organizationId;

  try {
    if (saga.state === SagaState.PENDING) {
      organizationId = await createOrganization(saga.id, dto);
      saga = { ...saga, state: SagaState.ORG_CREATED, organizationId };
    }

    if (saga.state === SagaState.ORG_CREATED) {
      const adminUserId = await createAdminCredentials(saga.id, organizationId!, dto);
      saga = { ...saga, state: SagaState.CREDENTIALS_CREATED, adminUserId };
    }

    if (saga.state === SagaState.CREDENTIALS_CREATED) {
      await assignDefaultPlan(saga.id, organizationId!);
      saga = { ...saga, state: SagaState.SUBSCRIBED };
    }

    if (saga.state === SagaState.SUBSCRIBED) {
      // adminUserId is the persisted one when resuming, so it is never re-minted.
      await completeOnboarding(saga.id, organizationId!, saga.adminUserId!, dto);
    }

    return (await organizations.findById(getPrisma(), organizationId!))!;
  } catch (err) {
    if (err instanceof OrganizationSlugTakenError) {
      // A naming conflict, not a saga failure: nothing was created.
      throw new ConflictException(err.message);
    }
    await markFailed(saga.id, organizationId, (err as Error).message);
    throw new ConflictException({
      statusCode: 409,
      error: 'ONBOARDING_INCOMPLETE',
      message:
        'Onboarding could not complete. Retry with the same request — it will resume from where it left off.',
    });
  }
}

/** No findBySlug() first: the unique constraint is the guarantee (no TOCTOU). */
async function createOrganization(sagaId: string, dto: SignupDto): Promise<string> {
  const slug = slugify(dto.organizationName);

  const organizationId = await runGlobal(async (tx) => {
    const org = await organizations.create(tx, { name: dto.organizationName, slug });
    await sagas.advance(tx, sagaId, SagaState.ORG_CREATED, { organizationId: org.id });
    return org.id;
  });

  await publishEvent(organizationId, EVENT_TYPES.ORGANIZATION_CREATED, {
    organizationId,
    name: dto.organizationName,
  });

  return organizationId;
}

/**
 * The minted userId is persisted on the saga so OrganizationProvisioned carries it
 * and the first admin's users row gets the SAME id as credentials.user_id.
 */
async function createAdminCredentials(
  sagaId: string,
  organizationId: string,
  dto: SignupDto,
): Promise<string> {
  const { userId } = await asFormerRemoteCall(() =>
    credentialsService.createCredentials({
      organizationId,
      email: dto.adminEmail,
      password: dto.adminPassword,
    }),
  );
  await runGlobal((tx) =>
    sagas.advance(tx, sagaId, SagaState.CREDENTIALS_CREATED, { adminUserId: userId }),
  );
  return userId;
}

async function assignDefaultPlan(sagaId: string, organizationId: string): Promise<void> {
  await asFormerRemoteCall(() => subscriptions.assignDefaultPlan(organizationId));
  await runGlobal((tx) => sagas.advance(tx, sagaId, SagaState.SUBSCRIBED, {}));
}

async function completeOnboarding(
  sagaId: string,
  organizationId: string,
  adminUserId: string,
  dto: SignupDto,
): Promise<void> {
  await runGlobal(async (tx) => {
    await organizations.updateStatus(tx, organizationId, 'active');
    await sagas.advance(tx, sagaId, SagaState.COMPLETE, {});
  });
  // The org becomes loggable-into here: the users module creates the first admin
  // user from this event, with the id minted for the credential.
  await publishEvent(organizationId, EVENT_TYPES.ORGANIZATION_PROVISIONED, {
    organizationId,
    adminUserId,
    adminEmail: dto.adminEmail,
    adminFirstName: dto.adminFirstName,
    adminLastName: dto.adminLastName,
  });
}

/**
 * Records the failure WITHOUT moving `state`, and marks the organisation
 * provisioning_failed (if one exists yet) so it is visibly stuck.
 */
async function markFailed(
  sagaId: string,
  organizationId: string | null,
  error: string,
): Promise<void> {
  await runGlobal(async (tx) => {
    await sagas.markFailed(tx, sagaId, error);
    if (organizationId) {
      await organizations.updateStatus(tx, organizationId, 'provisioning_failed');
    }
  });
  logger.warn(`Onboarding saga ${sagaId} failed: ${error}`);
  await publishEvent(organizationId, EVENT_TYPES.ONBOARDING_FAILED, {
    sagaId,
    organizationId,
    error,
  });
}

/**
 * Credential creation and plan assignment used to be HTTP calls, whose failures
 * reached the saga as axios errors ("Request failed with status code 409"). That
 * message is persisted as last_error and carried in OnboardingFailed, so an HTTP
 * error from the in-process call is re-labelled the same way.
 */
async function asFormerRemoteCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof HttpException) {
      throw new Error(`Request failed with status code ${err.status}`, { cause: err });
    }
    throw err;
  }
}

async function publishEvent<T>(
  organizationId: string | null,
  eventType: EventType,
  payload: T,
): Promise<void> {
  await publish(TOPICS.ORGANIZATION, { eventType, organizationId, actorUserId: null, payload });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}
