import cron from 'node-cron';
import { createLogger } from '../lib/logger';
import { purgeExpired } from '../services/token-denylist.service';
import { runInvitationExpirySweep } from './invitation-expiry-sweep';

const logger = createLogger('Jobs');

/** Scheduled work, formerly @nestjs/schedule in user-service plus Redis TTL expiry. */
export function startJobs(): { stop: () => void } {
  const tasks = [
    // Hourly, on the hour — the same schedule as @Cron(CronExpression.EVERY_HOUR).
    cron.schedule('0 * * * *', () => {
      runInvitationExpirySweep().catch((err: unknown) =>
        logger.error({ err }, `Invitation expiry sweep failed: ${(err as Error).message}`),
      );
    }),
    cron.schedule('30 * * * *', () => {
      purgeExpired()
        .then((count) => count > 0 && logger.debug(`Purged ${count} expired denylist entries`))
        .catch((err: unknown) =>
          logger.error({ err }, `Denylist cleanup failed: ${(err as Error).message}`),
        );
    }),
  ];
  return { stop: () => tasks.forEach((t) => void t.stop()) };
}
