import 'reflect-metadata';
import { createApp } from './app';
import { env } from './config/env';
import { registerEventHandlers } from './events';
import { startJobs } from './jobs';
import { logger } from './lib/logger';
import { disconnectPrisma } from './lib/prisma';
import { assertRlsSafeRole } from './lib/tenant-db';

async function bootstrap(): Promise<void> {
  // Refuse to boot as a role that can bypass RLS — fail closed on misconfiguration.
  await assertRlsSafeRole();

  registerEventHandlers();
  const jobs = startJobs();

  const server = createApp().listen(env.port, () => {
    logger.info(`Backend listening on :${env.port}`);
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    jobs.stop();
    server.close(() => {
      void disconnectPrisma().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err: unknown) => {
  logger.fatal({ err }, `Failed to start: ${(err as Error).message}`);
  process.exit(1);
});
