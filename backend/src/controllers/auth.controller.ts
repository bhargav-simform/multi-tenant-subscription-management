import type { Request, Response } from 'express';
import { LogoutDto, type LoginDto, type RefreshDto } from '../dtos/auth.dto';
import { createLogger } from '../lib/logger';
import { validateDto } from '../middlewares/validate';
import * as authService from '../services/auth.service';
import * as denylist from '../services/token-denylist.service';
import type { JwtAccessPayload } from '../types/tenant-context';
import { toLoginResponse } from '../views/auth.view';

const logger = createLogger('AuthController');

/** POST /auth/login — public. */
export async function login(req: Request, res: Response): Promise<void> {
  const session = await authService.login(req.body as LoginDto);
  res.status(200).json(toLoginResponse(session));
}

/**
 * POST /auth/refresh — public: the credential is the refresh token in the body. An
 * access token cannot be required, since refresh is called precisely when it expired.
 */
export async function refresh(req: Request, res: Response): Promise<void> {
  const session = await authService.refresh(req.body as RefreshDto);
  res.status(200).json(toLoginResponse(session));
}

/**
 * POST /auth/logout — authenticated, because only a verified token's jti can be
 * trusted for the denylist. Order matters: deny the access token FIRST (before the
 * body is even validated), then revoke the refresh token, so a failure afterwards
 * still leaves the access token dead.
 */
export async function logout(req: Request, res: Response): Promise<void> {
  await denyOwnAccessToken(req.user!);
  const dto = await validateDto(LogoutDto, req.body);
  await authService.logout(dto.refreshToken);
  res.status(204).end();
}

/**
 * TTL = the token's remaining lifetime. A denylist failure must not make logout
 * impossible: the refresh token is still revoked, so the access token merely lives
 * out its TTL — logged as a real degradation.
 */
async function denyOwnAccessToken(user: JwtAccessPayload): Promise<void> {
  const remainingTtl = user.exp - Math.floor(Date.now() / 1000);
  if (remainingTtl <= 0) return;

  try {
    await denylist.deny(user.jti, remainingTtl);
  } catch (err) {
    logger.error(`Failed to denylist access token jti=${user.jti}: ${(err as Error).message}`);
  }
}
