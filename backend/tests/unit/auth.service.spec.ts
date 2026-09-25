import { jest, describe, it, expect, beforeEach, beforeAll } from '@jest/globals';
import { hashPassword } from '../../src/lib/hashing';
import * as credentials from '../../src/models/credential.model';
import { EmailTakenError, type Credential } from '../../src/models/credential.model';
import * as refreshTokens from '../../src/models/refresh-token.model';
import type { RefreshToken } from '../../src/models/refresh-token.model';
import * as events from '../../src/lib/events';
import * as authService from '../../src/services/auth.service';
import { createCredentials } from '../../src/services/credentials.service';
import * as tokenIssuer from '../../src/services/token-issuer.service';
import * as usersRead from '../../src/services/users-read.service';
import { Role } from '../../src/types/constants';

jest.mock('../../src/models/credential.model', () => ({
  ...jest.requireActual<typeof import('../../src/models/credential.model')>(
    '../../src/models/credential.model',
  ),
  findByEmail: jest.fn(),
  findByUserId: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../../src/models/refresh-token.model', () => ({
  findByTokenHash: jest.fn(),
  create: jest.fn(),
  markReplaced: jest.fn(),
  revokeAllForCredential: jest.fn(),
  revoke: jest.fn(),
}));
jest.mock('../../src/services/token-issuer.service', () => ({
  issue: jest.fn(),
  rotate: jest.fn(),
}));
jest.mock('../../src/services/users-read.service', () => ({ getRoleForAuthService: jest.fn() }));
jest.mock('../../src/lib/events', () => ({ publish: jest.fn(), publishAll: jest.fn() }));
jest.mock('../../src/lib/prisma', () => ({ getPrisma: () => ({}) }));
jest.mock('../../src/lib/tenant-db', () => ({
  runGlobal: (work: (tx: unknown) => unknown) => Promise.resolve(work({})),
}));

const credentialsMock = jest.mocked(credentials);
const refreshTokensMock = jest.mocked(refreshTokens);
const tokenIssuerMock = jest.mocked(tokenIssuer);
const getRole = jest.mocked(usersRead.getRoleForAuthService);
const publish = jest.mocked(events.publish);

/**
 * The security-critical properties: no existence oracle, refresh-token rotation and
 * reuse detection, and that credentialId (the row's own id) is never confused with
 * userId (the domain user's id).
 */
describe('auth.service', () => {
  let correctHash: string;

  function makeCredential(overrides: Partial<Credential> = {}): Credential {
    return {
      id: 'credential-1',
      userId: 'user-1',
      organizationId: 'org-1',
      email: 'admin@acme.test',
      passwordHash: correctHash,
      status: 'active',
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

  beforeAll(async () => {
    correctHash = await hashPassword('correct-password');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    credentialsMock.findByEmail.mockResolvedValue(null);
    credentialsMock.findByUserId.mockResolvedValue(null);
    credentialsMock.findById.mockResolvedValue(null);
    refreshTokensMock.findByTokenHash.mockResolvedValue(null);
    refreshTokensMock.revokeAllForCredential.mockResolvedValue(undefined);
    refreshTokensMock.revoke.mockResolvedValue(undefined);
    tokenIssuerMock.issue.mockResolvedValue({
      accessToken: 'access-1',
      refreshToken: 'refresh-raw-1',
    });
    tokenIssuerMock.rotate.mockResolvedValue({
      accessToken: 'access-2',
      refreshToken: 'refresh-raw-2',
    });
    getRole.mockResolvedValue({ role: Role.ORG_MEMBER as 'org_member' });
    publish.mockResolvedValue(undefined);
  });

  describe('login', () => {
    it('rejects an unknown email with a GENERIC message — no existence oracle', async () => {
      await expect(authService.login({ email: 'nobody@acme.test', password: 'x' })).rejects.toThrow(
        'Invalid credentials',
      );
      expect(publish).toHaveBeenCalledWith(
        'security.events',
        expect.objectContaining({ payload: expect.objectContaining({ reason: 'unknown_email' }) }),
      );
    });

    it('rejects a wrong password with the SAME generic message as unknown email', async () => {
      credentialsMock.findByEmail.mockResolvedValue(makeCredential());

      await expect(
        authService.login({ email: 'admin@acme.test', password: 'wrong-password' }),
      ).rejects.toMatchObject({
        status: 401,
        message: 'Invalid credentials',
      });
    });

    it('issues tokens with the role fetched from the users module for an org-scoped credential', async () => {
      const credential = makeCredential();
      credentialsMock.findByEmail.mockResolvedValue(credential);
      getRole.mockResolvedValue({ role: 'org_admin' });

      const result = await authService.login({
        email: credential.email,
        password: 'correct-password',
      });

      expect(getRole).toHaveBeenCalledWith(credential.userId);
      expect(result.roles).toEqual([Role.ORG_ADMIN]);
      // The token issuer receives credential.id (this row's PK), never userId.
      expect(tokenIssuerMock.issue).toHaveBeenCalledWith(
        expect.anything(),
        credential.id,
        expect.objectContaining({ userId: credential.userId }),
      );
    });

    it('a platform admin (organizationId null) never asks the users module for a role', async () => {
      const credential = makeCredential({ organizationId: null });
      credentialsMock.findByEmail.mockResolvedValue(credential);

      const result = await authService.login({
        email: credential.email,
        password: 'correct-password',
      });

      expect(getRole).not.toHaveBeenCalled();
      expect(result.roles).toEqual([Role.PLATFORM_ADMIN]);
    });

    it('FAILS CLOSED when there is no users row yet for this user (e.g. mid-onboarding)', async () => {
      credentialsMock.findByEmail.mockResolvedValue(makeCredential());
      getRole.mockResolvedValue({ role: null });

      // Must NOT silently log the caller in as ORG_MEMBER.
      await expect(
        authService.login({ email: 'admin@acme.test', password: 'correct-password' }),
      ).rejects.toThrow('Account is not fully provisioned yet');
    });

    it('rejects a disabled credential', async () => {
      credentialsMock.findByEmail.mockResolvedValue(makeCredential({ status: 'disabled' }));

      await expect(
        authService.login({ email: 'admin@acme.test', password: 'correct-password' }),
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('refresh', () => {
    it('looks up the credential by ITS OWN id (credentialId), not by userId', async () => {
      refreshTokensMock.findByTokenHash.mockResolvedValue(
        makeRefreshToken({ credentialId: 'credential-1' }),
      );
      credentialsMock.findById.mockResolvedValue(makeCredential({ id: 'credential-1' }));

      await authService.refresh({ refreshToken: 'raw-token' });

      expect(credentialsMock.findById).toHaveBeenCalledWith(expect.anything(), 'credential-1');
      expect(credentialsMock.findByUserId).not.toHaveBeenCalled();
    });

    it('rejects an unknown refresh token', async () => {
      await expect(authService.refresh({ refreshToken: 'garbage' })).rejects.toThrow(
        'Invalid refresh token',
      );
    });

    it('rejects an expired refresh token', async () => {
      refreshTokensMock.findByTokenHash.mockResolvedValue(
        makeRefreshToken({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(authService.refresh({ refreshToken: 'raw-token' })).rejects.toThrow(
        'Refresh token expired',
      );
    });

    it('REUSE of an already-revoked token revokes the WHOLE family, not just this token', async () => {
      refreshTokensMock.findByTokenHash.mockResolvedValue(
        makeRefreshToken({ credentialId: 'credential-1', revokedAt: new Date() }),
      );

      await expect(authService.refresh({ refreshToken: 'stolen-token' })).rejects.toMatchObject({
        status: 403,
        message: 'Refresh token has been revoked',
      });

      expect(refreshTokensMock.revokeAllForCredential).toHaveBeenCalledWith(
        expect.anything(),
        'credential-1',
      );
      expect(publish).toHaveBeenCalledWith(
        'security.events',
        expect.objectContaining({
          payload: expect.objectContaining({ reason: 'refresh_token_reuse' }),
        }),
      );
    });
  });

  describe('createCredentials', () => {
    it('mints userId itself — the input never carries one in', async () => {
      credentialsMock.create.mockResolvedValue(makeCredential());

      const result = await createCredentials({
        organizationId: '6f1c2c1e-4b8a-4f7e-9a51-2f0f4d1c7b10',
        email: 'new-admin@acme.test',
        password: 'super-secret-password',
      });

      expect(typeof result.userId).toBe('string');
      // UserCredentialsCreated carries the SAME id, so the users row gets a matching PK.
      expect(publish).toHaveBeenCalledWith(
        'user.events',
        expect.objectContaining({ payload: expect.objectContaining({ userId: result.userId }) }),
      );
    });

    it('translates a duplicate email into a 409, not a raw database error', async () => {
      credentialsMock.create.mockRejectedValue(new EmailTakenError('taken@acme.test'));

      await expect(
        createCredentials({
          organizationId: '6f1c2c1e-4b8a-4f7e-9a51-2f0f4d1c7b10',
          email: 'taken@acme.test',
          password: 'super-secret-password',
        }),
      ).rejects.toMatchObject({
        status: 409,
        message: 'Email "taken@acme.test" is already registered',
      });
    });

    it('still validates its input like the former HTTP boundary did (400 on a short password)', async () => {
      await expect(
        createCredentials({ email: 'x@acme.test', password: 'short' }),
      ).rejects.toMatchObject({
        status: 400,
      });
      expect(credentialsMock.create).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the refresh token when it exists', async () => {
      const token = makeRefreshToken();
      refreshTokensMock.findByTokenHash.mockResolvedValue(token);

      await authService.logout('raw-token');

      expect(refreshTokensMock.revoke).toHaveBeenCalledWith(expect.anything(), token.id);
    });

    it('does nothing (no error) when the token is already gone', async () => {
      await expect(authService.logout('garbage')).resolves.toBeUndefined();
      expect(refreshTokensMock.revoke).not.toHaveBeenCalled();
    });
  });
});
