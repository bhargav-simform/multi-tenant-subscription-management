import type { Request, Response } from 'express';
import type { AcceptInvitationDto } from '../dtos/invitations.dto';
import * as usersService from '../services/users.service';
import * as usersReadService from '../services/users-read.service';
import { toInvitationResponse } from '../views/invitation.view';
import { toUserResponse } from '../views/user.view';

/** GET /invitations — pending invitations for the Users page. */
export async function list(_req: Request, res: Response): Promise<void> {
  const invitations = await usersReadService.listPendingInvitations();
  res.status(200).json(invitations.map(toInvitationResponse));
}

/** POST /invitations/:token/accept — public; the token is the credential. */
export async function accept(req: Request, res: Response): Promise<void> {
  const user = await usersService.acceptInvitation(
    req.params.token as string,
    req.body as AcceptInvitationDto,
  );
  res.status(201).json(toUserResponse(user));
}

/** DELETE /invitations/:id — revokes a pending invitation and releases its seat. */
export async function revoke(req: Request, res: Response): Promise<void> {
  await usersService.revokeInvitation(req.params.id as string);
  res.status(204).end();
}
