/** Thrown by CredentialRepository.create() on a unique_violation for `email`. */
export class EmailTakenError extends Error {
  constructor(email: string) {
    super(`Email "${email}" is already registered`);
    this.name = 'EmailTakenError';
  }
}
