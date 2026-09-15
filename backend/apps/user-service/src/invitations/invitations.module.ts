import { Module } from '@nestjs/common';
import { InvitationRepository } from './invitation.repository';
import { INVITATION_REPOSITORY } from './invitation.repository.interface';

/**
 * Repository-only. InvitationsController lives in UsersModule instead (not
 * here) — it depends on UsersService, and UsersModule already imports this
 * module for the repository token, so putting the controller here too would
 * create a circular module dependency for no reason. §8.4 treats users and
 * invitations as one cohesive domain anyway.
 */
@Module({
  providers: [{ provide: INVITATION_REPOSITORY, useClass: InvitationRepository }],
  exports: [INVITATION_REPOSITORY],
})
export class InvitationsModule {}
