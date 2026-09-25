import { subscribe } from '../../lib/events';
import { transaction } from '../../lib/tenant-db';
import * as users from '../../models/user.model';
import { EVENT_TYPES, TOPICS, type EventEnvelope } from '../../types/events';

interface OrganizationProvisionedPayload {
  organizationId: string;
  adminUserId: string;
  adminEmail: string;
  adminFirstName: string;
  adminLastName: string;
}

/**
 * Creates the organisation's first org_admin user, with the id the credential was
 * minted under. Runs in the envelope's org scope. used_seats is not touched here.
 */
export async function handle(envelope: EventEnvelope): Promise<void> {
  if (envelope.eventType !== EVENT_TYPES.ORGANIZATION_PROVISIONED) return;
  const payload = envelope.payload as OrganizationProvisionedPayload;

  await transaction((tx) =>
    users.create(tx, {
      id: payload.adminUserId,
      organizationId: payload.organizationId,
      email: payload.adminEmail,
      firstName: payload.adminFirstName,
      lastName: payload.adminLastName,
      role: 'org_admin',
    }),
  );
}

export function register(): void {
  subscribe(TOPICS.ORGANIZATION, 'OrganizationProvisioned', handle);
}
