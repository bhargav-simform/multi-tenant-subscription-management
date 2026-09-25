import type { Organization } from '../models/organization.model';
import type { CursorPage } from '../types/pagination';

/** Metadata only — this table has no content field to leak. */
export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface SignupResponse {
  organizationId: string;
  organizationName: string;
  status: string;
}

export function toOrganizationResponse(org: Organization): OrganizationResponse {
  return { id: org.id, name: org.name, slug: org.slug, status: org.status };
}

export function toOrganizationPage(
  page: CursorPage<Organization>,
): CursorPage<OrganizationResponse> {
  return { ...page, items: page.items.map(toOrganizationResponse) };
}

export function toSignupResponse(org: Organization): SignupResponse {
  return { organizationId: org.id, organizationName: org.name, status: org.status };
}
