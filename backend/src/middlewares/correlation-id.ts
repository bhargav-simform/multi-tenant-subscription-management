import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { CORRELATION_ID_HEADER } from '../types/constants';

/**
 * Accepts the client's x-correlation-id or mints a UUID, and echoes it on the
 * response. Runs before everything else so even a 401 has an id in its log line;
 * it becomes the correlationId of every event (and audit row) the request produces.
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const existing = req.header(CORRELATION_ID_HEADER);
  const id = existing && existing.length > 0 ? existing : randomUUID();
  req.headers[CORRELATION_ID_HEADER] = id;
  res.setHeader(CORRELATION_ID_HEADER, id);
  next();
}
