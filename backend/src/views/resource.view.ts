import type { Resource } from '../models/resource.model';
import type { CursorPage } from '../types/pagination';

/** Deliberately no organizationId: no response may confirm which tenant owns a row. */
export interface ResourceResponse {
  id: string;
  name: string;
  description: string | null;
  sizeBytes: number;
  createdBy: string;
  createdAt: Date;
}

export function toResourceResponse(resource: Resource): ResourceResponse {
  return {
    id: resource.id,
    name: resource.name,
    description: resource.description,
    sizeBytes: resource.sizeBytes,
    createdBy: resource.createdBy,
    createdAt: resource.createdAt,
  };
}

export function toResourcePageResponse(page: CursorPage<Resource>): CursorPage<ResourceResponse> {
  return { ...page, items: page.items.map(toResourceResponse) };
}
