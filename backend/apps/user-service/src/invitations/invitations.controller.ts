import { Body, Controller, Delete, Param, Post } from '@nestjs/common';
import { Action, Subject } from '@app/common';
import { CheckAbility } from '@app/authorization';
import { UsersService } from '../users/users.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import type { UserResponseDto } from '../users/dto/user-response.dto';

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly users: UsersService) {}

  /**
   * §11.5: this is ONE of exactly three routes the CLIENT reaches with no
   * authenticated identity — but that "public" status belongs to api-gateway
   * alone (its JwtAuthGuard, its own @Public() from libs/auth). This service's
   * own @app/tenant-context Public() decorator must NEVER appear on a
   * downstream route (§13.7 row 6, and InternalContextGuard's own comment) —
   * doing so was a real, already-committed defect: it skipped signature
   * verification for this route entirely, so anyone able to reach this
   * service directly (bypassing the gateway) could call it with no
   * x-internal-context signature at all. Fixed by removing the decorator.
   * The gateway signs an ANONYMOUS context for this route (§9.4) — an invitee
   * has no account yet, and the token itself is the credential — and this
   * service's InternalContextGuard verifies that signature exactly like any
   * other request; the handler simply has no caller identity to read.
   */
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
