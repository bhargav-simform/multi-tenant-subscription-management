/** Thrown by InvitationRepository.create() on a unique_violation for (organizationId, email) while pending. */
export class InvitationAlreadyPendingError extends Error {
  constructor(email: string) {
    super(`An invitation for "${email}" is already pending in this organization`);
    this.name = 'InvitationAlreadyPendingError';
  }
}
