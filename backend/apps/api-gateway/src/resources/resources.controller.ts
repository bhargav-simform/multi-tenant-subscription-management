import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ProxyService } from '../proxy/proxy.service';

/** §8.1/§8.6: resource-service's routes, forwarded unchanged. */
@Controller('resources')
export class ResourcesController {
  constructor(private readonly proxy: ProxyService) {}

  /** §19.6: the storage-limit path. Its 409 and specific message pass through (R6). */
  @Post()
  create(@Body() body: unknown): Promise<unknown> {
    return this.proxy.forward({ service: 'resource', method: 'POST', path: '/resources', body });
  }

  @Get()
  list(@Query() query: Record<string, string>): Promise<unknown> {
    return this.proxy.forward({
      service: 'resource',
      method: 'GET',
      path: '/resources',
      query,
    });
  }

  /**
   * H1 — the sharpest cross-tenant target in the system (§13.1). A well-formed
   * request for another org's resource id must return 404. The gateway makes no
   * decision here at all: it cannot, because it does not know which org owns the
   * row. RLS in resource-service decides, and ProxyService forwards the 404 verbatim.
   */
  @Get(':id')
  getById(@Param('id') id: string): Promise<unknown> {
    return this.proxy.forward({
      service: 'resource',
      method: 'GET',
      path: `/resources/${encodeURIComponent(id)}`,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    await this.proxy.forward({
      service: 'resource',
      method: 'DELETE',
      path: `/resources/${encodeURIComponent(id)}`,
    });
  }
}
