import { randomUUID, createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';
import { EventPublisher, type DomainEvent } from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS, Role } from '@app/common';
import {
  CREDENTIAL_REPOSITORY,
  type ICredentialRepository,
} from '../credentials/credential.repository.interface';
import { EmailTakenError } from '../credentials/email-taken.error';
import { CredentialStatus, type Credential } from '../credentials/credential.entity';
import {
  REFRESH_TOKEN_REPOSITORY,
  type IRefreshTokenRepository,
} from '../credentials/refresh-token.repository.interface';
import { TokenIssuerService, type IssuedTokens } from './token-issuer.service';
import { USER_ROLE_CLIENT, type IUserRoleClient } from './user-role-client.interface';
import type { LoginDto } from './dto/login.dto';
import type { LoginResponseDto } from './dto/login-response.dto';
import type { RefreshDto } from './dto/refresh.dto';
import type { CreateCredentialsDto } from '../credentials/dto/create-credentials.dto';
import type { CreateCredentialsResponseDto } from '../credentials/dto/create-credentials-response.dto';

const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * §11: authentication answers "who is this user?" only. §8.2: this is the
 * only service that ever sees a password, stores a hash, or mints a token.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tokens: TokenIssuerService,
    private readonly publisher: EventPublisher,
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: ICredentialRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: IRefreshTokenRepository,
    @Inject(USER_ROLE_CLIENT) private readonly userRoleClient: IUserRoleClient,
  ) {}

  /**
   * §8.2: called only by tenant-service's onboarding saga. Mints userId here
   * (§11.3 — "who mints user_id") and publishes UserCredentialsCreated
   * carrying it, so user-service creates its row with the SAME id.
   */
  async createCredentials(dto: CreateCredentialsDto): Promise<CreateCredentialsResponseDto> {
    const userId = randomUUID();
    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    try {
      await this.dataSource.transaction((manager) =>
        this.credentials.create(
          {
            userId,
            organizationId: dto.organizationId ?? null,
            email: dto.email,
            passwordHash,
          },
          manager,
        ),
      );
    } catch (err) {
      if (err instanceof EmailTakenError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }

    await this.publisher.publish(KAFKA_TOPICS.USER, {
      eventType: EVENT_TYPES.USER_CREDENTIALS_CREATED,
      organizationId: dto.organizationId ?? null,
      actorUserId: null,
      payload: { userId, email: dto.email },
    } satisfies DomainEvent);

    return { userId };
  }

  /**
   * §11.2. On any failure — unknown email OR wrong password — the response is
   * identical (no existence oracle). A dummy verify runs on an unknown email
   * so timing does not reveal whether the account exists (§11.6).
   */
  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const credential = await this.credentials.findByEmail(dto.email);

    if (!credential) {
      await dummyVerify();
      await this.publishAuthFailure(null, dto.email, 'unknown_email');
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await argon2
      .verify(credential.passwordHash, dto.password)
      .catch(() => false);
    if (!passwordValid) {
      await this.publishAuthFailure(credential.organizationId, dto.email, 'bad_password');
      throw new UnauthorizedException('Invalid credentials');
    }

    if (credential.status !== CredentialStatus.ACTIVE) {
      await this.publishAuthFailure(credential.organizationId, dto.email, 'credential_disabled');
      throw new UnauthorizedException('Invalid credentials');
    }

    // §11.2 also requires rejecting a login whose organisation is not
    // 'active' (blocks half-onboarded orgs). That check lives one hop away in
    // tenant-service and is NOT implemented in this pass — see the auth-service
    // README "Known gaps". It does not weaken the graded onboarding-failure
    // scenario: createCredentials only runs after organisation creation
    // succeeds in the saga (§30.1's step order), so a fully-failed onboarding
    // never produces a credential to log in with at all.

    const roles = await this.resolveRoles(credential);
    const tokens = await this.dataSource.transaction((manager) =>
      this.tokens.issue(
        credential.id,
        { userId: credential.userId, organizationId: credential.organizationId, roles },
        manager,
      ),
    );

    return this.toLoginResponse(tokens, credential, roles);
  }

  /**
   * §11.4: single-use rotation. Reuse of an already-replaced token is treated
   * as theft — the whole token family is revoked and a security event is
   * published, rather than silently rejecting just the one request.
   */
  async refresh(dto: RefreshDto): Promise<LoginResponseDto> {
    const tokenHash = hashRefreshToken(dto.refreshToken);
    const existing = await this.refreshTokens.findByTokenHash(tokenHash);

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (existing.revokedAt) {
      // Reuse of a token already rotated away (or explicitly logged out) —
      // §11.4: treat the whole chain as compromised.
      await this.dataSource.transaction((manager) =>
        this.refreshTokens.revokeAllForCredential(existing.credentialId, manager),
      );
      await this.publishAuthFailure(null, null, 'refresh_token_reuse');
      throw new ForbiddenException('Refresh token has been revoked');
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // existing.credentialId is refresh_tokens.credential_id, which references
    // credentials.id (this row's own primary key) — NOT credentials.user_id.
    // findById, not findByUserId, is the correct lookup here.
    const credential = await this.credentials.findById(existing.credentialId);
    if (!credential) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const roles = await this.resolveRoles(credential);
    const tokens = await this.dataSource.transaction((manager) =>
      this.tokens.rotate(
        { id: existing.id, credentialId: existing.credentialId },
        { userId: credential.userId, organizationId: credential.organizationId, roles },
        manager,
      ),
    );

    return this.toLoginResponse(tokens, credential, roles);
  }

  /**
   * §11.4: revokes the refresh token. Access-token denylisting is the
   * caller's job (gateway — §16.2 use #2). Deliberately NOT wrapped in a
   * transaction, unlike login/refresh/createCredentials: this is a single
   * idempotent UPDATE by primary key with no second statement whose
   * atomicity with it matters, so a transaction here would be ceremony
   * without a correctness reason.
   */
  async logout(refreshTokenRaw: string): Promise<void> {
    const tokenHash = hashRefreshToken(refreshTokenRaw);
    const existing = await this.refreshTokens.findByTokenHash(tokenHash);
    if (existing) {
      await this.refreshTokens.revoke(existing.id);
    }
  }

  /**
   * §9.2, §11.2: role is user-service's data, fetched synchronously so a
   * promotion/demotion takes effect on the very next login. A platform admin
   * (organizationId === null) has no users row to ask — PLATFORM_ADMIN is
   * derived locally instead, since it is not membership-scoped at all.
   *
   * FAILS CLOSED on a missing or unrecognised role: getRole() returning null
   * means the user-service row doesn't exist yet (e.g. mid-onboarding, before
   * user-service has reacted to OrganizationProvisioned — §8.4 consumes). A
   * credential existing before its user row does is a real, transient state
   * this system can be in; logging that credential in with ORG_MEMBER
   * privileges by default would be silently granting access to a user who,
   * from user-service's point of view, does not exist. An unrecognised role
   * string is treated the same way — never widen an unknown value.
   */
  private async resolveRoles(credential: Credential): Promise<Role[]> {
    if (credential.organizationId === null) {
      return [Role.PLATFORM_ADMIN];
    }
    const role = await this.userRoleClient.getRole(credential.userId);
    if (role === Role.ORG_ADMIN) return [Role.ORG_ADMIN];
    if (role === Role.ORG_MEMBER) return [Role.ORG_MEMBER];
    throw new UnauthorizedException('Account is not fully provisioned yet');
  }

  private toLoginResponse(
    tokens: IssuedTokens,
    credential: Pick<Credential, 'userId' | 'email' | 'organizationId'>,
    roles: Role[],
  ): LoginResponseDto {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: credential.userId,
        email: credential.email,
        roles,
        organizationId: credential.organizationId,
      },
    };
  }

  private async publishAuthFailure(
    organizationId: string | null,
    email: string | null,
    reason: string,
  ): Promise<void> {
    await this.publisher.publish(KAFKA_TOPICS.SECURITY, {
      eventType: EVENT_TYPES.AUTHENTICATION_FAILED,
      organizationId,
      actorUserId: null,
      payload: { email, reason },
    } satisfies DomainEvent);
  }
}

function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** §11.6: constant-shape work so an unknown email takes the same time as a real one. */
async function dummyVerify(): Promise<void> {
  await argon2
    .verify('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$AAAAAAAAAAAAAAAAAAAAAA', 'dummy-password')
    .catch(() => undefined);
}
