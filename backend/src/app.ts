import 'reflect-metadata';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { correlationId } from './middlewares/correlation-id';
import { errorHandler } from './middlewares/error-handler';
import { apiRouter } from './routes';
import { CORRELATION_ID_HEADER } from './types/constants';

/**
 * The HTTP application. Built by a factory (no listen) so tests drive it with
 * supertest; server.ts adds the boot checks, cron jobs and the listener.
 *
 * Pipeline: helmet -> CORS allowlist -> JSON body -> correlation id -> request log
 * -> /api/v1 routes -> error serialiser. Per-route middleware is
 * throttle -> authenticate|anonymous -> requirePlatformAdmin -> authorize -> validate
 * -> controller (see routes/).
 */
export function createApp(): Express {
  const app = express();

  app.use(helmet());
  // An allowlist, never `origin: true` — reflecting any origin with credentials is
  // the standard way this control is accidentally disabled.
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(express.json());
  app.use(correlationId);
  app.use(
    pinoHttp({
      logger,
      customProps: (req) => ({ correlationId: req.headers[CORRELATION_ID_HEADER] }),
    }),
  );

  app.use('/api/v1', apiRouter());

  // No JSON 404 handler on purpose: an unknown route falls through to Express's
  // default "Cannot GET /path" page, which is what clients have always received.
  app.use(errorHandler);
  return app;
}
