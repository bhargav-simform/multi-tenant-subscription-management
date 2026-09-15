import { Body, Controller, Delete, Param, Post } from '@nestjs/common';
import { Action, Subject } from '@app/common';
import { CheckAbility } from '@app/authorization';
import { Public } from '@app/tenant-context';
import { UsersService } from '../users/users.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import type { UserResponseDto } from '../users/dto/user-response.dto';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly users: UsersService) {}

  /**
   * §11.5: one of exactly three @Public() gateway routes. The gateway signs
   * an ANONYMOUS context for this route (§9.4) — this service's
   * InternalContextGuard still verifies that signature; the handler simply
   * has no caller identity to read (there is none — an invitee has no
   * account yet, and the token itself is the credential, §11.5).
   */
  @Public()
  @Post(':token/accept')
  accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
  ): Promise<UserResponseDto> {
    return this.users.acceptInvitation(token, dto);
  }

  @Delete(':id')
  @CheckAbility(Action.DELETE, Subject.USER)
  async revoke(@Param('id') id: string): Promise<void> {
    await this.users.revokeInvitation(id);
  }
}
