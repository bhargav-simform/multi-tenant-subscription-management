import { Router } from 'express';
import * as users from '../controllers/users.controller';
import { InviteUserDto, ListUsersQueryDto, UpdateRoleDto } from '../dtos/users.dto';
import { authenticate } from '../middlewares/authenticate';
import { authorize } from '../middlewares/authorize';
import { throttle } from '../middlewares/throttle';
import { validateBody, validateQuery } from '../middlewares/validate';
import { Action, Subject } from '../types/constants';

/** :id is deliberately not UUID-validated — a malformed id was always a 500 from the DB. */
export function usersRoutes(): Router {
  const router = Router();
  router.post(
    '/users/invite',
    throttle,
    authenticate,
    authorize(Action.CREATE, Subject.USER),
    validateBody(InviteUserDto),
    users.invite,
  );
  router.get(
    '/users',
    throttle,
    authenticate,
    authorize(Action.READ, Subject.USER),
    validateQuery(ListUsersQueryDto),
    users.list,
  );
  router.get(
    '/users/:id',
    throttle,
    authenticate,
    authorize(Action.READ, Subject.USER),
    users.getById,
  );
  router.patch(
    '/users/:id/role',
    throttle,
    authenticate,
    authorize(Action.UPDATE, Subject.USER),
    validateBody(UpdateRoleDto),
    users.updateRole,
  );
  router.delete(
    '/users/:id',
    throttle,
    authenticate,
    authorize(Action.DELETE, Subject.USER),
    users.remove,
  );
  return router;
}
