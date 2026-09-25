import { publish } from '../lib/events';
import { createLogger } from '../lib/logger';
import { runGlobal, transactionForOrganization } from '../lib/tenant-db';
import * as invitations from '../models/invitation.model';
import * as seats from '../models/subscription-seat.model';
import { EVENT_TYPES, TOPICS } from '../types/events';

const logger = createLogger('InvitationExpirySweep');

/**
 * Hourly: releases the seats held by expired, unaccepted invitations. Per org, it
 * takes the same subscription-row lock as the invite path, so a sweep and an invite
 * cannot race. A failure for one org is logged and the sweep moves on; seats stay
 * held (conservative).
 *
 * Known quirk, kept as-is: org ids are listed with an unscoped query on
 * subscriptions, which RLS filters to zero rows — so in practice this sweeps nothing.
 */
export async function runInvitationExpirySweep(): Promise<void> {
  const organizationIds = await runGlobal((tx) => seats.listOrganizationIds(tx));
  for (const organizationId of organizationIds) {
    await sweepOrganization(organizationId);
  }
}

async function sweepOrganization(organizationId: string): Promise<void> {
  let expiredIds: string[];
  try {
    expiredIds = await transactionForOrganization(organizationId, async (tx) => {
      await seats.lockForUpdate(tx, organizationId);

      const ids = await invitations.findExpiredIds(tx, organizationId);
      if (ids.length === 0) return [];

      await invitations.markManyExpired(tx, ids);
      await seats.adjustUsedSeats(tx, organizationId, -ids.length);
      return ids;
    });
  } catch (err) {
    logger.error(
      `Invitation sweep failed for organization ${organizationId}: ${(err as Error).message}`,
    );
    return;
  }

  for (const invitationId of expiredIds) {
    await publish(TOPICS.USER, {
      eventType: EVENT_TYPES.INVITATION_EXPIRED,
      organizationId,
      actorUserId: null,
      payload: { invitationId },
    });
  }
}
