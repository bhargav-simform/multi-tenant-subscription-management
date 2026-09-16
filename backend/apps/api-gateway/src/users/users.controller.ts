import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ProxyService } from '../proxy/proxy.service';

/**
 * §8.1: user-service's routes, forwarded unchanged. Every fine-grained rule —
 * "org admins mutate, org members read themselves" (§12.3), the seat limit (§19),
 * cross-tenant 404-by-id (R8/H1) — is enforced by user-service. The gateway holds
 * no opinion about any of them, per §10.3.
 */
@Controller()
export class UsersController {
  constructor(private readonly proxy: ProxyService) {}

  /** §19: the seat-limit path. The 409 it can return is passed through verbatim (R6). */
  @Post('users/invite')
  invite(@Body() body: unknown): Promise<unknown> {
    return this.proxy.forward({ service: 'user', method: 'POST', path: '/users/invite', body });
  }

  @Get('users')
  list(@Query() query: Record<string, string>): Promise<unknown> {
    return this.proxy.forward({ service: 'user', method: 'GET', path: '/users', query });
  }

  /** H1: a foreign-tenant id must reach the client as 404. ProxyService passes it through. */
  @Get('users/:id')
  getById(@Param('id') id: string): Promise<unknown> {
    return this.proxy.forward({
      service: 'user',
      method: 'GET',
      path: `/users/${encodeURIComponent(id)}`,
    });
  }

  @Patch('users/:id/role')
  updateRole(@Param('id') id: string, @Body() body: unknown): Promise<unknown> {
    return this.proxy.forward({
      service: 'user',
      method: 'PATCH',
      path: `/users/${encodeURIComponent(id)}/role`,
      body,
    });
  }

  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string): Promise<void> {
    await this.proxy.forward({
      service: 'user',
      method: 'DELETE',
      path: `/users/${encodeURIComponent(id)}`,
    });
  }

  /**
   * Revoking a pending invitation. Distinct from /invitations/:token/accept, which
   * is public and lives in its own controller — this one takes an invitation ID and
   * requires an authenticated org admin.
   */
  @Delete('invitations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeInvitation(@Param('id') id: string): Promise<void> {
    await this.proxy.forward({
      service: 'user',
      method: 'DELETE',
      path: `/invitations/${encodeURIComponent(id)}`,
    });
  }
}
