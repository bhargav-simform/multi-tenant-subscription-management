import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Action, Subject } from '@app/common';
import { CheckAbility } from '@app/authorization';
import { UsersService } from './users.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UsersReadService } from './users-read.service';
import type { CursorPage } from '@app/common';

@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly usersRead: UsersReadService,
  ) {}

  @Post('invite')
  @CheckAbility(Action.CREATE, Subject.USER)
  invite(@Body() dto: InviteUserDto): Promise<{ invitationId: string; tokenForDev: string }> {
    return this.users.invite(dto);
  }

  /** §29: keyset pagination, RLS-scoped. */
  @Get()
  @CheckAbility(Action.READ, Subject.USER)
  list(@Query() query: ListUsersQueryDto): Promise<CursorPage<UserResponseDto>> {
    return this.usersRead.listPage(query);
  }

  /**
   * §13, H1: the cross-tenant read-by-ID test target. A foreign-tenant id
   * returns 404 — RLS filters it before this handler even sees it as absent
   * vs. present; there is no code here that could distinguish the two cases,
   * which is the point.
   */
  @Get(':id')
  @CheckAbility(Action.READ, Subject.USER)
  getById(@Param('id') id: string): Promise<UserResponseDto> {
    return this.usersRead.getById(id);
  }

  @Patch(':id/role')
  @CheckAbility(Action.UPDATE, Subject.USER)
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto): Promise<UserResponseDto> {
    return this.users.updateRole(id, dto.role);
  }

  @Delete(':id')
  @CheckAbility(Action.DELETE, Subject.USER)
  async remove(@Param('id') id: string): Promise<void> {
    await this.users.removeUser(id);
  }
}
