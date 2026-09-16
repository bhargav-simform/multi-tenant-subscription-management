import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Action, Subject } from '@app/common';
import type { CursorPage } from '@app/common';
import { CheckAbility } from '@app/authorization';
import { ResourcesService } from './resources.service';
import { CreateResourceDto } from './dto/create-resource.dto';
import { ListResourcesQueryDto } from './dto/list-resources-query.dto';
import { ResourceResponseDto } from './dto/resource-response.dto';

/**
 * §8.6. HTTP only — no business rules, no transactions, no repository access.
 *
 * Note the route shapes (§13.3): NO route is `/organizations/:orgId/...`, and
 * no handler accepts an organisation id in a body, query or param. Where an id
 * appears it is the RESOURCE id, and RLS decides whether that row is visible.
 *
 * @CheckAbility checks the SUBJECT TYPE only ("may this role ever delete a
 * Resource") — the CASL conditions for ORG_MEMBER (§12.3:
 * `createdBy === userId`) need a loaded row, so they are enforced in
 * ResourcesService after the RLS-scoped read.
 */
@Controller('resources')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  /** §19.6: enforces the storage limit in one transaction. 409 on breach. */
  @Post()
  @CheckAbility(Action.CREATE, Subject.RESOURCE)
  create(@Body() dto: CreateResourceDto): Promise<ResourceResponseDto> {
    return this.resources.create(dto);
  }

  /** §29: keyset-paginated, RLS-scoped. */
  @Get()
  @CheckAbility(Action.READ, Subject.RESOURCE)
  list(@Query() query: ListResourcesQueryDto): Promise<CursorPage<ResourceResponseDto>> {
    return this.resources.listPage(query);
  }

  /**
   * §13, H1 — the sharpest cross-tenant test target in the system. A
   * foreign-tenant id returns 404, identical to a nonexistent one; there is
   * no code path here that could return 403 or otherwise confirm existence.
   */
  @Get(':id')
  @CheckAbility(Action.READ, Subject.RESOURCE)
  getById(@Param('id', ParseUUIDPipe) id: string): Promise<ResourceResponseDto> {
    return this.resources.getById(id);
  }

  /** Frees storage (§19.6 in reverse). Ownership condition enforced in the service. */
  @Delete(':id')
  @HttpCode(204)
  @CheckAbility(Action.DELETE, Subject.RESOURCE)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.resources.remove(id);
  }
}
