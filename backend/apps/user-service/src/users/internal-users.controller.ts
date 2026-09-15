import { Controller, Get, Param } from '@nestjs/common';
import { UsersReadService } from './users-read.service';

/**
 * §9.2, §11.2: internal-only, matches the top-level path §8.4 specifies —
 * NOT nested under /users. Called by auth-service at login/refresh. No
 * @CheckAbility() — the caller has no tenant context/roles to evaluate a
 * CASL rule against (§13.6's SECURITY DEFINER exception resolves the org
 * internally, inside UsersReadService).
 */
@Controller('internal/users')
export class InternalUsersController {
  constructor(private readonly usersRead: UsersReadService) {}

  @Get(':id/role')
  getRole(@Param('id') id: string): Promise<{ role: string | null }> {
    return this.usersRead.getRoleForAuthService(id);
  }
}
