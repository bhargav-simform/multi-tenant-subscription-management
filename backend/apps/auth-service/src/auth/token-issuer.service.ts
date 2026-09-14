import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import type { EntityManager } from 'typeorm';
import type { Role } from '@app/common';
import type { JwtAccessPayload } from '@app/auth';
import {
  REFRESH_TOKEN_REPOSITORY,
  type IRefreshTokenRepository,
} from '../credentials/refresh-token.repository.interface';

const REFRESH_TOKEN_HASH_ENCODING = 'hex';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Identity going into the access token JWT claims (§11.4) — `userId` is the
 * domain user's id (`sub` claim), distinct from `credentialId` (this table's
 * own primary key, which `refresh_tokens.credential_id` references). The two
 * are NEVER interchangeable: confusing them would point a refresh token at
 * the wrong row.
 */
export interface TokenPrincipal {
  userId: string;
  organizationId: string | null;
  roles: Role[];
}

/**
 * §11.4: mints both tokens. The access token is a signed JWT the caller
 * verifies itself downstream (via api-gateway's JwtStrategy — §11.5); the
 * refresh token is an opaque random value whose SHA-256 hash is what's stored
 * (§11.4 "hash in auth_db") — never the raw token, so a database read alone
 * can never produce a usable refresh token.
 */
@Injectable()
export class TokenIssuerService {
  private readonly accessExpiresIn: string;
  private readonly refreshExpiresInDays: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: IRefreshTokenRepository,
  ) {
    this.accessExpiresIn = this.config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m');
    this.refreshExpiresInDays = parseDays(this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d'));
  }

  /**
   * Mints a fresh access+refresh pair for a brand-new session (login).
   * `credentialId` is the row this refresh token belongs to — the credential's
   * own id, not the user's.
   */
  async issue(
    credentialId: string,
    principal: TokenPrincipal,
    manager: EntityManager,
  ): Promise<IssuedTokens> {
    const accessToken = this.signAccessToken(principal);
    const { raw, hash } = this.generateOpaqueToken();
    await this.refreshTokens.create(
      { credentialId, tokenHash: hash, expiresAt: this.refreshExpiryDate() },
      manager,
    );
    return { accessToken, refreshToken: raw };
  }

  /**
   * §11.4 rotation: issues a new pair, marks the PRESENTED refresh token row
   * as replaced by the new one. Caller (AuthService) has already verified the
   * presented token is valid, unexpired and unrevoked.
   */
  async rotate(
    presentedToken: { id: string; credentialId: string },
    principal: TokenPrincipal,
    manager: EntityManager,
  ): Promise<IssuedTokens> {
    const accessToken = this.signAccessToken(principal);
    const { raw, hash } = this.generateOpaqueToken();
    const newToken = await this.refreshTokens.create(
      {
        credentialId: presentedToken.credentialId,
        tokenHash: hash,
        expiresAt: this.refreshExpiryDate(),
      },
      manager,
    );
    await this.refreshTokens.markReplaced(presentedToken.id, newToken.id, manager);
    return { accessToken, refreshToken: raw };
  }

  private signAccessToken(principal: TokenPrincipal): string {
    const payload: Omit<JwtAccessPayload, 'iat' | 'exp'> = {
      sub: principal.userId,
      organizationId: principal.organizationId,
      roles: principal.roles,
      jti: randomUUID(),
    };
    return this.jwt.sign(payload, { expiresIn: this.accessExpiresIn as StringValue });
  }

  /** Never store the raw token — only its hash (§11.4). */
  private generateOpaqueToken(): { raw: string; hash: string } {
    const raw = randomUUID() + randomUUID();
    const hash = createHash('sha256').update(raw).digest(REFRESH_TOKEN_HASH_ENCODING);
    return { raw, hash };
  }

  private refreshExpiryDate(): Date {
    return new Date(Date.now() + this.refreshExpiresInDays * MS_PER_DAY);
  }
}

function parseDays(expr: string): number {
  const match = /^(\d+)d$/.exec(expr);
  return match ? Number(match[1]) : 7;
}
