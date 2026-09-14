import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';
import { EventPublisher } from '@app/kafka';
import { Role } from '@app/common';
import { AuthService } from '../auth.service';
import { TokenIssuerService } from '../token-issuer.service';
import {
  CREDENTIAL_REPOSITORY,
} from '../../credentials/credential.repository.interface';
import {
  REFRESH_TOKEN_REPOSITORY,
} from '../../credentials/refresh-token.repository.interface';
import { USER_ROLE_CLIENT } from '../user-role-client.interface';
import { CredentialStatus, type Credential } from '../../credentials/credential.entity';
import type { RefreshToken } from '../../credentials/refresh-token.entity';
import { EmailTakenError } from '../../credentials/email-taken.error';

type CredRepoMock = {
  findByEmail: jest.Mock<() => Promise<Credential | null>>;
  findByUserId: jest.Mock<() => Promise<Credential | null>>;
  findById: jest.Mock<(id: string) => Promise<Credential | null>>;
  create: jest.Mock<() => Promise<Credential>>;
};

type RefreshRepoMock = {
  findByTokenHash: jest.Mock<() => Promise<RefreshToken | null>>;
  create: jest.Mock<() => Promise<RefreshToken>>;
  markReplaced: jest.Mock<(id: string, replacedById: string, manager: unknown) => Promise<void>>;
  revokeAllForCredential: jest.Mock<(credentialId: string, manager: unknown) => Promise<void>>;
  revoke: jest.Mock<(id: string) => Promise<void>>;
};

/**
 * §11: authentication is "who is this user?" only. These tests focus on the
 * security-critical properties the architecture calls out explicitly:
 * no existence oracle, dummy-verify timing, refresh-token rotation/reuse
 * detection, and that credentialId (this row's own id) is never confused
 * with userId (the domain user's id) — the exact bug fixed during review.
 */
describe('AuthService', () => {
  let credentials: CredRepoMock;
  let refreshTokens: RefreshRepoMock;
  let dataSource: { transaction: jest.Mock<(work: (m: unknown) => unknown) => Promise<unknown>> };
  let publisher: { publish: jest.Mock<(topic: string, event: unknown) => Promise<void>> };
  let userRoleClient: { getRole: jest.Mock<(userId: string) => Promise<string | null>> };

  function makeCredential(overrides: Partial<Credential> = {}): Credential {
    return {
      id: 'credential-1',
      userId: 'user-1',
      organizationId: 'org-1',
      email: 'admin@acme.test',
      passwordHash: '',
      status: CredentialStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function makeRefreshToken(overrides: Partial<RefreshToken> = {}): RefreshToken {
    return {
      id: 'refresh-1',
      credentialId: 'credential-1',
      tokenHash: 'hash',
      expiresAt: new Date(Date.now() + 100000),
      revokedAt: null,
      replacedBy: null,
      createdAt: new Date(),
      ...overrides,
    };
  }

  async function buildService() {
    credentials = {
      findByEmail: jest.fn<() => Promise<Credential | null>>().mockResolvedValue(null),
      findByUserId: jest.fn<() => Promise<Credential | null>>().mockResolvedValue(null),
      findById: jest.fn<(id: string) => Promise<Credential | null>>().mockResolvedValue(null),
      create: jest.fn<() => Promise<Credential>>(),
    };
    refreshTokens = {
      findByTokenHash: jest.fn<() => Promise<RefreshToken | null>>().mockResolvedValue(null),
      create: jest.fn<() => Promise<RefreshToken>>().mockResolvedValue(makeRefreshToken()),
      markReplaced: jest
        .fn<(id: string, replacedById: string, manager: unknown) => Promise<void>>()
        .mockResolvedValue(undefined),
      revokeAllForCredential: jest
        .fn<(credentialId: string, manager: unknown) => Promise<void>>()
        .mockResolvedValue(undefined),
      revoke: jest.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    dataSource = {
      transaction: jest
        .fn<(work: (m: unknown) => unknown) => Promise<unknown>>()
        .mockImplementation(async (work) => work({})),
    };
    publisher = {
      publish: jest
        .fn<(topic: string, event: unknown) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
    userRoleClient = {
      getRole: jest
        .fn<(userId: string) => Promise<string | null>>()
        .mockResolvedValue(Role.ORG_MEMBER),
    };

    const mockTokenIssuer = {
      issue: jest
        .fn<(credentialId: string, principal: unknown, manager: unknown) => Promise<{ accessToken: string; refreshToken: string }>>()
        .mockResolvedValue({ accessToken: 'access-1', refreshToken: 'refresh-raw-1' }),
      rotate: jest
        .fn<(presentedToken: unknown, principal: unknown, manager: unknown) => Promise<{ accessToken: string; refreshToken: string }>>()
        .mockResolvedValue({ accessToken: 'access-2', refreshToken: 'refresh-raw-2' }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: DataSource, useValue: dataSource },
        { provide: EventPublisher, useValue: publisher },
        { provide: CREDENTIAL_REPOSITORY, useValue: credentials },
        { provide: REFRESH_TOKEN_REPOSITORY, useValue: refreshTokens },
        { provide: USER_ROLE_CLIENT, useValue: userRoleClient },
        { provide: TokenIssuerService, useValue: mockTokenIssuer },
      ],
    }).compile();

    return {
      service: moduleRef.get(AuthService),
      tokenIssuer: mockTokenIssuer,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('login', () => {
    it('rejects an unknown email with a GENERIC message — no existence oracle', async () => {
      const { service } = await buildService();
      credentials.findByEmail.mockResolvedValue(null);

      await expect(service.login({ email: 'nobody@acme.test', password: 'x' })).rejects.toThrow(
        'Invalid credentials',
      );
      expect(publisher.publish).toHaveBeenCalledWith(
        'security.events',
        expect.objectContaining({ payload: expect.objectContaining({ reason: 'unknown_email' }) }),
      );
    });

    it('rejects a wrong password with the SAME generic message as unknown email', async () => {
      const { service } = await buildService();
      const hash = await argon2.hash('correct-password', {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      credentials.findByEmail.mockResolvedValue(makeCredential({ passwordHash: hash }));

      await expect(
        service.login({ email: 'admin@acme.test', password: 'wrong-password' }),
      ).rejects.toThrow('Invalid credentials');
    });

    it('issues tokens with the role fetched from user-service for an org-scoped credential', async () => {
      const { service, tokenIssuer } = await buildService();
      const hash = await argon2.hash('correct-password', {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      const credential = makeCredential({ passwordHash: hash });
      credentials.findByEmail.mockResolvedValue(credential);
      userRoleClient.getRole.mockResolvedValue(Role.ORG_ADMIN);

      const result = await service.login({ email: credential.email, password: 'correct-password' });

      expect(userRoleClient.getRole).toHaveBeenCalledWith(credential.userId);
      expect(result.user.roles).toEqual([Role.ORG_ADMIN]);
      // The token issuer receives credential.id (this row's PK), never userId —
      // this is the distinction the review caught.
      expect(tokenIssuer.issue).toHaveBeenCalledWith(
        credential.id,
        expect.objectContaining({ userId: credential.userId }),
        expect.anything(),
      );
    });

    it('a platform admin (organizationId null) never calls user-service for a role', async () => {
      const { service } = await buildService();
      const hash = await argon2.hash('correct-password', {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      const credential = makeCredential({ organizationId: null, passwordHash: hash });
      credentials.findByEmail.mockResolvedValue(credential);

      const result = await service.login({ email: credential.email, password: 'correct-password' });

      expect(userRoleClient.getRole).not.toHaveBeenCalled();
      expect(result.user.roles).toEqual([Role.PLATFORM_ADMIN]);
    });

    it('FAILS CLOSED when user-service has no role yet for this user (e.g. mid-onboarding)', async () => {
      const { service } = await buildService();
      const hash = await argon2.hash('correct-password', {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      credentials.findByEmail.mockResolvedValue(makeCredential({ passwordHash: hash }));
      userRoleClient.getRole.mockResolvedValue(null);

      // A credential can legitimately exist before user-service has created
      // its row (§8.4 consumes OrganizationProvisioned asynchronously). This
      // must NOT silently log the caller in as ORG_MEMBER — that would grant
      // access to a "user" that, from user-service's point of view, does not
      // exist yet.
      await expect(
        service.login({ email: 'admin@acme.test', password: 'correct-password' }),
      ).rejects.toThrow('Account is not fully provisioned yet');
    });

    it('rejects a disabled credential', async () => {
      const { service } = await buildService();
      const hash = await argon2.hash('correct-password', {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      credentials.findByEmail.mockResolvedValue(
        makeCredential({ passwordHash: hash, status: CredentialStatus.DISABLED }),
      );

      await expect(
        service.login({ email: 'admin@acme.test', password: 'correct-password' }),
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('refresh', () => {
    it('looks up the credential by ITS OWN id (credentialId), not by userId', async () => {
      const { service } = await buildService();
      const token = makeRefreshToken({ credentialId: 'credential-1' });
      refreshTokens.findByTokenHash.mockResolvedValue(token);
      credentials.findById.mockResolvedValue(makeCredential({ id: 'credential-1' }));

      await service.refresh({ refreshToken: 'raw-token' });

      expect(credentials.findById).toHaveBeenCalledWith('credential-1');
      expect(credentials.findByUserId).not.toHaveBeenCalled();
    });

    it('rejects an unknown refresh token', async () => {
      const { service } = await buildService();
      refreshTokens.findByTokenHash.mockResolvedValue(null);

      await expect(service.refresh({ refreshToken: 'garbage' })).rejects.toThrow(
        'Invalid refresh token',
      );
    });

    it('rejects an expired refresh token', async () => {
      const { service } = await buildService();
      refreshTokens.findByTokenHash.mockResolvedValue(
        makeRefreshToken({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(service.refresh({ refreshToken: 'raw-token' })).rejects.toThrow(
        'Refresh token expired',
      );
    });

    it('REUSE of an already-revoked token revokes the WHOLE family, not just this token', async () => {
      const { service } = await buildService();
      refreshTokens.findByTokenHash.mockResolvedValue(
        makeRefreshToken({ credentialId: 'credential-1', revokedAt: new Date() }),
      );

      await expect(service.refresh({ refreshToken: 'stolen-token' })).rejects.toThrow(
        'Refresh token has been revoked',
      );

      expect(refreshTokens.revokeAllForCredential).toHaveBeenCalledWith(
        'credential-1',
        expect.anything(),
      );
      expect(publisher.publish).toHaveBeenCalledWith(
        'security.events',
        expect.objectContaining({
          payload: expect.objectContaining({ reason: 'refresh_token_reuse' }),
        }),
      );
    });
  });

  describe('createCredentials', () => {
    it('mints userId itself — the DTO never carries one in (§11.3)', async () => {
      const { service } = await buildService();
      credentials.create.mockResolvedValue(makeCredential());

      const result = await service.createCredentials({
        organizationId: 'org-1',
        email: 'new-admin@acme.test',
        password: 'super-secret-password',
      });

      expect(result.userId).toBeDefined();
      expect(typeof result.userId).toBe('string');
      // publishes UserCredentialsCreated carrying the SAME id it returned —
      // this is what lets user-service create a row with a matching primary key.
      expect(publisher.publish).toHaveBeenCalledWith(
        'user.events',
        expect.objectContaining({
          payload: expect.objectContaining({ userId: result.userId }),
        }),
      );
    });

    it('translates a duplicate email into a 409, not a raw database error', async () => {
      const { service } = await buildService();
      credentials.create.mockRejectedValue(new EmailTakenError('taken@acme.test'));

      await expect(
        service.createCredentials({
          organizationId: 'org-1',
          email: 'taken@acme.test',
          password: 'super-secret-password',
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('logout', () => {
    it('revokes the refresh token when it exists', async () => {
      const { service } = await buildService();
      const token = makeRefreshToken();
      refreshTokens.findByTokenHash.mockResolvedValue(token);

      await service.logout('raw-token');

      expect(refreshTokens.revoke).toHaveBeenCalledWith(token.id);
    });

    it('does nothing (no error) when the token is already gone', async () => {
      const { service } = await buildService();
      refreshTokens.findByTokenHash.mockResolvedValue(null);

      await expect(service.logout('garbage')).resolves.toBeUndefined();
      expect(refreshTokens.revoke).not.toHaveBeenCalled();
    });
  });
});
