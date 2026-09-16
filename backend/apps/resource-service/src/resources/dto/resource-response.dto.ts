/**
 * §13.9: deliberately does NOT expose organizationId. The caller's own
 * organisation is implied by their token and is not information the API needs
 * to echo; more importantly, no response in this service should ever carry an
 * organisation identifier that could confirm which tenant owns a row.
 */
export class ResourceResponseDto {
  id!: string;
  name!: string;
  description!: string | null;
  sizeBytes!: number;
  createdBy!: string;
  createdAt!: Date;
}
