import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { InternalUsersController } from './internal-users.controller';
import { UsersService } from './users.service';
import { UsersReadService } from './users-read.service';
import { UserRepository } from './user.repository';
import { USER_REPOSITORY } from './user.repository.interface';
import { InvitationsModule } from '../invitations/invitations.module';
import { InvitationsController } from '../invitations/invitations.controller';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

/**
 * Owns both UsersController and InvitationsController — see
 * invitations.module.ts for why the invitation controller lives here rather
 * than there (avoids a circular module dependency; both controllers call
 * into UsersService, which lives here).
 */
@Module({
  imports: [InvitationsModule, SubscriptionsModule],
  controllers: [UsersController, InternalUsersController, InvitationsController],
  providers: [
    UsersService,
    UsersReadService,
    { provide: USER_REPOSITORY, useClass: UserRepository },
  ],
  exports: [USER_REPOSITORY, UsersService],
})
export class UsersModule {}
