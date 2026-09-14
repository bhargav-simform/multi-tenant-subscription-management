import { jest, describe, it, expect } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { OrganizationsController } from '../organizations.controller';
import { OrganizationsService } from '../organizations.service';
import { OrganizationStatus, type Organization } from '../organization.entity';
import type { CursorPage } from '@app/common';

/**
 * §13.6 / T4 (ARCHITECTURE.md §28.2): asserts the platform-admin org list DTO
 * carries ONLY metadata fields. This table holds no content (§8.3), so this
 * test is really asserting the DTO mapper hasn't grown a field that shouldn't
 * exist — the structural guarantee is that this table has nothing else to leak.
 */
describe('OrganizationsController', () => {
  const org: Organization = {
    id: 'org-1',
    name: 'Acme Inc',
    slug: 'acme-inc',
    status: OrganizationStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  async function buildController(serviceOverrides: Partial<OrganizationsService> = {}) {
    const service = {
      getMyOrganization: jest.fn<() => Promise<Organization>>().mockResolvedValue(org),
      listOrganizations: jest
        .fn<() => Promise<CursorPage<Organization>>>()
        .mockResolvedValue({ items: [org], nextCursor: null, hasMore: false }),
      getOrganizationById: jest.fn<() => Promise<Organization>>().mockResolvedValue(org),
      ...serviceOverrides,
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [{ provide: OrganizationsService, useValue: service }],
    }).compile();
    return moduleRef.get(OrganizationsController);
  }

  it('returns only metadata fields for the platform-admin list — no content field exists to leak', async () => {
    const controller = await buildController();
    const page = await controller.listOrganizations({});

    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]).sort()).toEqual(['id', 'name', 'slug', 'status'].sort());
  });

  it('getMyOrganization never accepts an organisation id from the caller', () => {
    // Structural assertion, not a runtime one: the controller method takes no
    // parameters at all, so there is no argument through which a caller could
    // request a DIFFERENT organisation's data (§13.3).
    expect(OrganizationsController.prototype.getMyOrganization).toHaveLength(0);
  });
});
