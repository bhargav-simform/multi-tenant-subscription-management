import type { Params } from 'nestjs-pino';
import type { IncomingMessage } from 'node:http';
import { CORRELATION_ID_HEADER } from '@app/common';

/**
 * §26.1: structured JSON everywhere, pretty-printed only in local dev.
 * §26.1 redaction: password/token/secret paths never reach a log line.
 * §26.2: correlationId is read from the header already set by
 * InternalContextGuard / the gateway, so every log line in a request carries it.
 */
export function buildPinoConfig(serviceName: string, nodeEnv: string): Params {
  return {
    pinoHttp: {
      name: serviceName,
      level: nodeEnv === 'production' ? 'info' : 'debug',
      transport:
        nodeEnv !== 'production'
          ? { target: 'pino-pretty', options: { singleLine: true } }
          : undefined,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-internal-context"]',
          'req.headers["x-internal-signature"]',
          '*.password',
          '*.passwordHash',
          '*.token',
          '*.refreshToken',
          '*.secret',
        ],
        censor: '[REDACTED]',
      },
      customProps: (req: IncomingMessage) => ({
        service: serviceName,
        correlationId: req.headers[CORRELATION_ID_HEADER],
      }),
    },
  };
}
