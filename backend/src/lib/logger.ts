import pino, { type LoggerOptions } from 'pino';
import { env } from '../config/env';

/**
 * Structured JSON everywhere, pretty-printed only in local dev. Password/token/secret
 * paths never reach a log line — same redaction list the Nest services used.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.secret',
];

function buildOptions(): LoggerOptions {
  const isProd = env.nodeEnv === 'production';
  return {
    name: 'backend',
    level: env.logLevel ?? (isProd ? 'info' : 'debug'),
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    transport:
      isProd || env.nodeEnv === 'test'
        ? undefined
        : { target: 'pino-pretty', options: { singleLine: true } },
  };
}

export const logger = pino(buildOptions());

/** A child logger tagged with the component name, the equivalent of Nest's `new Logger(Class.name)`. */
export function createLogger(context: string): pino.Logger {
  return logger.child({ context });
}
