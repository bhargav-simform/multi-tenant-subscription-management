import type { LoginDto, RefreshDto } from '../dtos/auth.dto';
import { publish } from '../lib/events';
import { sha256Hex, verifyPassword } from '../lib/hashing';
import {
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '../lib/http-errors';
import { createLogger } from '../lib/logger';
import { getPrisma } from '../lib/prisma';
import { runGlobal } from '../lib/tenant-db';
import * as credentials from '../models/credential.model';
import type { Credential } from '../models/credential.model';
import * as refreshTokens from '../models/refresh-token.model';
import { Role } from '../types/constants';
import { EVENT_TYPES, TOPICS } from '../types/events';
import * as tokenIssuer from './token-issuer.service';
import type { IssuedTokens } from './token-issuer.service';
import * as usersRead from './users-read.service';

const logger = createLogger('AuthService');

/** A valid argon2id hash of nothing anyone knows — verified against on an unknown email. */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$AAAAAAAAAAAAAAAAAAAAAA';

/** A signed-in session: the token pair plus who it was issued to (rendered by views/auth.view). */
export interface AuthSession extends IssuedTokens {
  credential: Credential;
  roles: Role[];
}

/**
 * Unknown email and wrong password fail identically (no existence oracle), and an
 * unknown email still pays for an argon2 verify so timing does not leak it either.
 *
 * Known gap, unchanged: a login whose organisation is not 'active' is not rejected
 * here. A fully-failed onboarding never creates a credential, and a credential whose
 * users row is missing fails closed in resolveRoles.
 */
export async function login(dto: LoginDto): Promise<AuthSession> {
  const credential = await credentials.findByEmail(getPrisma(), dto.email);

  if (!credential) {
    await dummyVerify();
    await publishAuthFailure(null, dto.email, 'unknown_email');
    throw new UnauthorizedException('Invalid credentials');
  }

  const passwordValid = await verifyPassword(credential.passwordHash, dto.password);
  if (!passwordValid) {
    await publishAuthFailure(credential.organizationId, dto.email, 'bad_password');
    throw new UnauthorizedException('Invalid credentials');
  }

  if (credential.status !== 'active') {
    await publishAuthFailure(credential.organizationId, dto.email, 'credential_disabled');
    throw new UnauthorizedException('Invalid credentials');
  }

  const roles = await resolveRoles(credential);
  const tokens = await runGlobal((tx) =>
    tokenIssuer.issue(tx, credential.id, {
      userId: credential.userId,
      organizationId: credential.organizationId,
      roles,
    }),
  );

  return { ...tokens, credential, roles };
}

/**
 * Single-use rotation. Presenting an already-revoked token (rotated away or logged
 * out) is treated as theft: the whole family is revoked and a security event is
 * published, rather than just rejecting the one request.
 */
export async function refresh(dto: RefreshDto): Promise<AuthSession> {
  const existing = await refreshTokens.findByTokenHash(getPrisma(), sha256Hex(dto.refreshToken));

  if (!existing) {
    throw new UnauthorizedException('Invalid refresh token');
  }

  if (existing.revokedAt) {
    await runGlobal((tx) => refreshTokens.revokeAllForCredential(tx, existing.credentialId));
    await publishAuthFailure(null, null, 'refresh_token_reuse');
    throw new ForbiddenException('Refresh token has been revoked');
  }

  if (existing.expiresAt.getTime() < Date.now()) {
    throw new UnauthorizedException('Refresh token expired');
  }

  // credential_id references credentials.id (the row's own PK), NOT user_id.
  const credential = await credentials.findById(getPrisma(), existing.credentialId);
  if (!credential) {
    throw new UnauthorizedException('Invalid refresh token');
  }

  const roles = await resolveRoles(credential);
  const tokens = await runGlobal((tx) =>
    tokenIssuer.rotate(
      tx,
      { id: existing.id, credentialId: existing.credentialId },
      { userId: credential.userId, organizationId: credential.organizationId, roles },
    ),
  );

  return { ...tokens, credential, roles };
}

/**
 * Revokes the refresh token; an unknown one is a silent no-op. Denylisting the
 * access token is the controller's half. No transaction: one idempotent UPDATE.
 */
export async function logout(refreshTokenRaw: string): Promise<void> {
  const existing = await refreshTokens.findByTokenHash(getPrisma(), sha256Hex(refreshTokenRaw));
  if (existing) {
    await refreshTokens.revoke(getPrisma(), existing.id);
  }
}

/**
 * Role is read fresh on every login/refresh so a promotion/demotion applies on the
 * next token. A platform admin (organizationId null) has no users row; the role is
 * derived locally. FAILS CLOSED on a missing or unrecognised role — a credential can
 * exist before its users row, and must not default to ORG_MEMBER.
 */
async function resolveRoles(credential: Credential): Promise<Role[]> {
  if (credential.organizationId === null) {
    return [Role.PLATFORM_ADMIN];
  }
  const role = await getRole(credential.userId);
  if (role === Role.ORG_ADMIN) return [Role.ORG_ADMIN];
  if (role === Role.ORG_MEMBER) return [Role.ORG_MEMBER];
  throw new UnauthorizedException('Account is not fully provisioned yet');
}

/**
 * Keeps the outcomes of the former HTTP role lookup: a 404 meant "no users row yet"
 * (null); any other failure was logged and surfaced as a plain 500 — so an
 * HttpException from the lookup is not passed through with its own status.
 */
async function getRole(userId: string): Promise<string | null> {
  try {
    return (await usersRead.getRoleForAuthService(userId)).role;
  } catch (err) {
    if (err instanceof NotFoundException) {
      return null;
    }
    logger.error(`Failed to fetch role for user ${userId}: ${(err as Error).message}`);
    throw err instanceof HttpException ? new Error((err as Error).message, { cause: err }) : err;
  }
}

async function publishAuthFailure(
  organizationId: string | null,
  email: string | null,
  reason: string,
): Promise<void> {
  await publish(TOPICS.SECURITY, {
    eventType: EVENT_TYPES.AUTHENTICATION_FAILED,
    organizationId,
    actorUserId: null,
    payload: { email, reason },
  });
}

async function dummyVerify(): Promise<void> {
  await verifyPassword(DUMMY_HASH, 'dummy-password');
}
