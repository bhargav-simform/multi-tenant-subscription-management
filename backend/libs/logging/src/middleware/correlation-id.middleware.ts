import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { CORRELATION_ID_HEADER } from '@app/common';

/**
 * §10.2, §26.2: minted at the gateway if the client didn't supply one, then
 * propagated to every downstream call and Kafka event so one id reconstructs a
 * full trace. Downstream services just forward whatever they received in
 * x-internal-context.correlationId (already verified by InternalContextGuard) —
 * this middleware is for api-gateway specifically, the entry point.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const existing = req.header(CORRELATION_ID_HEADER);
    const correlationId = existing && existing.length > 0 ? existing : randomUUID();
    req.headers[CORRELATION_ID_HEADER] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  }
}
