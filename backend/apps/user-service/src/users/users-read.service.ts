import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CursorPage, CursorQuery } from '@app/common';
import { USER_REPOSITORY, type IUserRepository } from './user.repository.interface';
import type { UserResponseDto } from './dto/user-response.dto';
import type { User } from './user.entity';

/**
 * Read paths split from UsersService (which owns the seat-limit mutations,
 * §19) — these never touch the subscription row and never need a
 * transaction. §20.1 layering: this is still the application-service layer,
 * just a narrower slice of it.
 */
@Injectable()
export class UsersReadService {
  constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepository) {}

  async listPage(query: CursorQuery): Promise<CursorPage<UserResponseDto>> {
    const page = await this.users.listPage(query);
    return { ...page, items: page.items.map(toDto) };
  }

  /**
   * §13, H1: the cross-tenant read-by-ID test target. IUserRepository.findById
   * is RLS-scoped (via TenantRepository, §13.5) — a foreign-tenant id returns
   * null here exactly as if the row didn't exist, and this method has no way
   * to tell the difference, which is the entire point.
   */
  async getById(id: string): Promise<UserResponseDto> {
    const user = await this.users.findById(id);
    if (!user) throw new NotFoundException();
    return toDto(user);
  }

  /** §9.2, §11.2, §13.6: crosses tenant boundaries by design — see the interface's doc comment. */
  async getRoleForAuthService(userId: string): Promise<{ role: string | null }> {
    const role = await this.users.findRoleByUserId(userId);
    return { role };
  }
}

function toDto(user: User): UserResponseDto {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    status: user.status,
  };
}
