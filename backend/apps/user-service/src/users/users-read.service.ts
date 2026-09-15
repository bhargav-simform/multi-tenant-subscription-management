import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import type { CursorPage, CursorQuery } from '@app/common';
import { USER_REPOSITORY, type IUserRepository } from './user.repository.interface';
import type { UserResponseDto } from './dto/user-response.dto';
import type { User } from './user.entity';

/**
 * Read paths split from UsersService (which owns the seat-limit mutations,
 * §19) — these never touch the subscription row, but they DO still need to
 * run inside a scoped transaction (§13.5, §15.3): `IUserRepository`'s
 * methods fall back to the raw injected `DataSource` when no manager is
 * passed, and `users.users` has FORCE ROW LEVEL SECURITY — a connection with
 * no `app.current_org` set returns zero rows UNCONDITIONALLY, for every
 * organisation, not just a foreign one (§32.4 records this as a real defect,
 * caught here and in UsersService's mutation paths). "Never needs a
 * transaction" was the original, incorrect assumption this class shipped
 * with; every method here now opens one via TenantAwareDataSource purely to
 * get `app.current_org` set, even though nothing here needs the ACID
 * properties of a transaction otherwise.
 */
@Injectable()
export class UsersReadService {
  constructor(
    private readonly tenantDataSource: TenantAwareDataSource,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
  ) {}

  async listPage(query: CursorQuery): Promise<CursorPage<UserResponseDto>> {
    const page = await this.tenantDataSource.transaction((manager) =>
      this.users.listPage(query, manager),
    );
    return { ...page, items: page.items.map(toDto) };
  }

  /**
   * §13, H1: the cross-tenant read-by-ID test target. Scoped via
   * TenantAwareDataSource so `app.current_org` is actually set on the
   * connection (§13.5) — a foreign-tenant id then returns null here exactly
   * as if the row didn't exist, and this method has no way to tell the
   * difference, which is the entire point.
   */
  async getById(id: string): Promise<UserResponseDto> {
    const user = await this.tenantDataSource.transaction((manager) =>
      this.users.findById(id, manager),
    );
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
