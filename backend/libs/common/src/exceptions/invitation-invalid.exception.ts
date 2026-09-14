import { GoneException } from '@nestjs/common';

/** §19.8: an expired or already-accepted invitation token. */
export class InvitationInvalidException extends GoneException {
  constructor() {
    super({
      statusCode: 410,
      error: 'INVITATION_INVALID',
      message: 'This invitation has expired or already been used.',
    });
  }
}
