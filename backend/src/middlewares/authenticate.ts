import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { contextStore } from '../lib/context-store';
import { UnauthorizedException } from '../lib/http-errors';
import * as denylist from '../services/token-denylist.service';
import { CORRELATION_ID_HEADER } from '../types/constants';
import type { JwtAccessPayload, TenantContextPayload } from '../types/tenant-context';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The verified access token payload. Set only by authenticate(). */
      user?: JwtAccessPayload;
    }
  }
}

/** Same extraction rule as passport-jwt's fromAuthHeaderAsBearerToken(). */
function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /(\S+)\s+(\S+)/.exec(header);
  if (!match || match[1].toLowerCase() !== 'bearer') return null;
  return match[2];
}

function correlationIdOf(req: Request): string {
  return req.header(CORRELATION_ID_HEADER) ?? '';
}

/**
 * The only place a client-supplied JWT is trusted. Verifies signature + expiry, then
 * the logout denylist, then opens the tenant-context scope for the rest of the
 * request from the token's claims — never from the body, query or path.
 *
 * Error bodies match the old Passport guard:
 *   missing/invalid/expired -> { message: 'Unauthorized', statusCode: 401 }
 *   denylisted              -> { message: 'Token has been revoked', error: 'Unauthorized', statusCode: 401 }
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractBearerToken(req);
  if (!token) throw new UnauthorizedException();

  let payload: JwtAccessPayload;
  try {
    payload = jwt.verify(token, env.jwtSecret) as JwtAccessPayload;
  } catch {
    throw new UnauthorizedException();
  }

  if (await denylist.isDenied(payload.jti)) {
    throw new UnauthorizedException('Token has been revoked');
  }

  req.user = payload;
  const context: TenantContextPayload = {
    userId: payload.sub,
    organizationId: payload.organizationId,
    roles: payload.roles,
    correlationId: correlationIdOf(req),
    iat: payload.iat,
    exp: payload.exp,
  };
  contextStore.run(context, () => next());
}

/**
 * For the four public routes (login, refresh, signup, accept invitation): no
 * identity yet, so an anonymous scope — userId and organizationId null, no roles.
 * Code on these paths must not assume either id is present.
 */
export function anonymous(req: Request, _res: Response, next: NextFunction): void {
  const now = Math.floor(Date.now() / 1000);
  contextStore.run(
    {
      userId: null,
      organizationId: null,
      roles: [],
      correlationId: correlationIdOf(req),
      iat: now,
      exp: now,
    },
    () => next(),
  );
}
