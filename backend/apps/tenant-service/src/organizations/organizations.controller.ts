import { Controller, Get, Param, Query } from '@nestjs/common';
import { Action, Subject } from '@app/common';
import { CheckAbility } from '@app/authorization';
import { OrganizationsService } from './organizations.service';
import { OrganizationResponseDto } from './dto/organization-response.dto';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import type { CursorPage } from '@app/common';
import type { Organization } from './organization.entity';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  /** §13.3: no :id in this path — "my organisation" comes only from the token. */
  @Get('me')
  @CheckAbility(Action.READ, Subject.ORGANIZATION)
  async getMyOrganization(): Promise<OrganizationResponseDto> {
    const org = await this.organizations.getMyOrganization();
    return toDto(org);
  }

  /**
   * §13.6, §12.3: Platform Admin only, enforced by CASL (org admin/member abilities
   * for Subject.ORGANIZATION are scoped to their own id and would reject a bare
   * list). Returns metadata only — see OrganizationsService for why that is
   * structural, not a filter someone remembered to add.
   */
  @Get()
  @CheckAbility(Action.READ, Subject.ORGANIZATION)
  async listOrganizations(
    @Query() query: ListOrganizationsQueryDto,
  ): Promise<CursorPage<OrganizationResponseDto>> {
    const page = await this.organizations.listOrganizations(query);
    return { ...page, items: page.items.map(toDto) };
  }

  @Get(':id')
  @CheckAbility(Action.READ, Subject.ORGANIZATION)
  async getOrganizationById(@Param('id') id: string): Promise<OrganizationResponseDto> {
    const org = await this.organizations.getOrganizationById(id);
    return toDto(org);
  }
}

function toDto(org: Organization): OrganizationResponseDto {
  return { id: org.id, name: org.name, slug: org.slug, status: org.status };
}
