import { ConflictException } from '@nestjs/common';

/** D-Q5: the last org admin cannot be removed or demoted. */
export class LastAdminException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      error: 'LAST_ADMIN_PROTECTED',
      message:
        'This organisation must have at least one admin. Promote another member before removing or demoting this one.',
    });
  }
}
