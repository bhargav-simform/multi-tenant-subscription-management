import { Module } from '@nestjs/common';
import { InvitationRepository } from './invitation.repository';
import { INVITATION_REPOSITORY } from './invitation.repository.interface';
import { AUTH_CLIENT } from './clients/auth-client.interface';
import { HttpAuthClient } from './clients/http-auth.client';

/**
 * Repository-only, plus the AUTH_CLIENT token invitation acceptance needs to
 * mint login credentials for the invitee (§11.3 — auth-service is the one
 * source of truth for userId). InvitationsController lives in UsersModule
 * instead (not here) — it depends on UsersService, and UsersModule already
 * imports this module for these tokens, so putting the controller here too
 * would create a circular module dependency for no reason. §8.4 treats users
 * and invitations as one cohesive domain anyway.
 */
@Module({
  providers: [
    { provide: INVITATION_REPOSITORY, useClass: InvitationRepository },
    { provide: AUTH_CLIENT, useClass: HttpAuthClient },
  ],
  exports: [INVITATION_REPOSITORY, AUTH_CLIENT],
})
export class InvitationsModule {}
