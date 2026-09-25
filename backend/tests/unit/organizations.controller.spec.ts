import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';
import * as controller from '../../src/controllers/organizations.controller';
import type { Organization } from '../../src/models/organization.model';
import * as organizationsService from '../../src/services/organizations.service';

jest.mock('../../src/services/organizations.service', () => ({
  getMyOrganization: jest.fn(),
  listOrganizations: jest.fn(),
  getOrganizationById: jest.fn(),
}));

const service = jest.mocked(organizationsService);

function mockResponse() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

/**
 * The platform-admin org list carries ONLY metadata fields. The table holds no
 * content, so this really asserts the presenter has not grown a field it shouldn't.
 */
describe('organizations.controller', () => {
  const org: Organization = {
    id: 'org-1',
    name: 'Acme Inc',
    slug: 'acme-inc',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service.getMyOrganization.mockResolvedValue(org);
    service.listOrganizations.mockResolvedValue({ items: [org], nextCursor: null, hasMore: false });
    service.getOrganizationById.mockResolvedValue(org);
  });

  it('returns only metadata fields for the platform-admin list — no content field exists to leak', async () => {
    const res = mockResponse();
    await controller.list({ validatedQuery: {} } as unknown as Request, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    const page = res.json.mock.calls[0][0] as { items: Record<string, unknown>[] };
    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]).sort()).toEqual(['id', 'name', 'slug', 'status'].sort());
  });

  it('getMine never reads an organisation id from the request', async () => {
    // A request with ids everywhere a caller could smuggle one: none reach the service.
    const req = {
      params: { id: 'org-2' },
      query: { id: 'org-2' },
      body: { organizationId: 'org-2' },
    };
    const res = mockResponse();

    await controller.getMine(req as unknown as Request, res as unknown as Response);

    expect(service.getMyOrganization).toHaveBeenCalledWith();
    expect(res.json).toHaveBeenCalledWith({
      id: 'org-1',
      name: 'Acme Inc',
      slug: 'acme-inc',
      status: 'active',
    });
  });
});
