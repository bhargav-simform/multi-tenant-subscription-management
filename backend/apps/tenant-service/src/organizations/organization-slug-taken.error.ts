/**
 * Thrown by OrganizationRepository.create() when the unique constraint on
 * `slug` is violated. §16.4 / §15.5 pattern: the check-then-write race is
 * resolved by relying on the database constraint as the real guarantee,
 * exactly like onboarding's idempotency key — never by a separate
 * findBySlug() read before the write, which is a TOCTOU under concurrency.
 */
export class OrganizationSlugTakenError extends Error {
  constructor(slug: string) {
    super(`Organization slug "${slug}" is already taken`);
    this.name = 'OrganizationSlugTakenError';
  }
}
