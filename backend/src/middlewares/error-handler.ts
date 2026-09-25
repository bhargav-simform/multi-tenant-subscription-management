import type { NextFunction, Request, Response } from 'express';
import { HttpException } from '../lib/http-errors';
import { createLogger } from '../lib/logger';

const logger = createLogger('ErrorHandler');

/** Express's own errors (body-parser) carry a status and `type`. */
interface HttpLikeError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
}

/**
 * Serialises every error into the NestJS body shapes (see lib/http-errors.ts).
 * Anything that is not an HttpException is a 500 with a fixed, detail-free body —
 * the real error is only ever logged.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpException) {
    res.status(err.status).json(err.getBody());
    return;
  }

  const e = err as HttpLikeError;
  const status = e?.status ?? e?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Malformed JSON / oversized body from express.json().
    const error = status === 413 ? 'Payload Too Large' : 'Bad Request';
    res.status(status).json({ message: e.message, error, statusCode: status });
    return;
  }

  logger.error({ err }, `Unhandled error: ${(err as Error)?.message ?? String(err)}`);
  res.status(500).json({ statusCode: 500, message: 'Internal server error' });
}
