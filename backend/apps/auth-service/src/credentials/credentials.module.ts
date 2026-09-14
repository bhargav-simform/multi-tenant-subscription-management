import { Module } from '@nestjs/common';
import { CredentialRepository } from './credential.repository';
import { CREDENTIAL_REPOSITORY } from './credential.repository.interface';
import { RefreshTokenRepository } from './refresh-token.repository';
import { REFRESH_TOKEN_REPOSITORY } from './refresh-token.repository.interface';

/**
 * Owns the two REGISTRY_TABLES repositories (§8.2, §13.8). No controller here
 * — CredentialsController lives in this module too, but AuthService (which
 * depends on both repositories) lives in AuthModule, so this module exports
 * both tokens for AuthModule to consume.
 */
@Module({
  providers: [
    { provide: CREDENTIAL_REPOSITORY, useClass: CredentialRepository },
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: RefreshTokenRepository },
  ],
  exports: [CREDENTIAL_REPOSITORY, REFRESH_TOKEN_REPOSITORY],
})
export class CredentialsModule {}
