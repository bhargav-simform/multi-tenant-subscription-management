import { Router } from 'express';
import * as invitations from '../controllers/invitations.controller';
import { AcceptInvitationDto } from '../dtos/invitations.dto';
import { anonymous, authenticate } from '../middlewares/authenticate';
import { authorize } from '../middlewares/authorize';
import { throttle } from '../middlewares/throttle';
import { validateBody } from '../middlewares/validate';
import { Action, Subject } from '../types/constants';

export function invitationsRoutes(): Router {
  const router = Router();
  router.get(
    '/invitations',
    throttle,
    authenticate,
    authorize(Action.READ, Subject.USER),
    invitations.list,
  );
  router.post(
    '/invitations/:token/accept',
    throttle,
    anonymous,
    validateBody(AcceptInvitationDto),
    invitations.accept,
  );
  router.delete(
    '/invitations/:id',
    throttle,
    authenticate,
    authorize(Action.DELETE, Subject.USER),
    invitations.revoke,
  );
  return router;
}
