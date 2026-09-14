/**
 * The three roles this system knows about (docs/architecture/ARCHITECTURE.md §2.1).
 * A PLATFORM_ADMIN's JWT carries organizationId = null (§11.3) — that null is what
 * makes the RLS-based content boundary in §13.6 hold.
 */
export enum Role {
  PLATFORM_ADMIN = 'platform_admin',
  ORG_ADMIN = 'org_admin',
  ORG_MEMBER = 'org_member',
}
