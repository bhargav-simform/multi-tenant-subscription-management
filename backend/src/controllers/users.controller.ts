import type { Request, Response } from 'express';
import type { InviteUserDto, ListUsersQueryDto, UpdateRoleDto } from '../dtos/users.dto';
import * as usersService from '../services/users.service';
import * as usersReadService from '../services/users-read.service';
import { toUserResponse } from '../views/user.view';

/** POST /users/invite — the seat-limit path; a full org gets 409 PLAN_LIMIT_EXCEEDED. */
export async function invite(req: Request, res: Response): Promise<void> {
  res.status(201).json(await usersService.invite(req.body as InviteUserDto));
}

/** GET /users — keyset-paginated, RLS-scoped. */
export async function list(req: Request, res: Response): Promise<void> {
  res.status(200).json(await usersReadService.listPage(req.validatedQuery as ListUsersQueryDto));
}

/** GET /users/:id — a foreign-tenant id is a 404, identical to a missing one. */
export async function getById(req: Request, res: Response): Promise<void> {
  res.status(200).json(toUserResponse(await usersReadService.getById(req.params.id as string)));
}

export async function updateRole(req: Request, res: Response): Promise<void> {
  const user = await usersService.updateRole(
    req.params.id as string,
    (req.body as UpdateRoleDto).role,
  );
  res.status(200).json(toUserResponse(user));
}

export async function remove(req: Request, res: Response): Promise<void> {
  await usersService.removeUser(req.params.id as string);
  res.status(204).end();
}
