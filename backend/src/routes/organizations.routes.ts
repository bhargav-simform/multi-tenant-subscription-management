import { Router } from 'express';
import * as organizations from '../controllers/organizations.controller';
import { ListOrganizationsQueryDto } from '../dtos/organizations.dto';
import { authenticate } from '../middlewares/authenticate';
import { authorize, requirePlatformAdmin } from '../middlewares/authorize';
import { throttle } from '../middlewares/throttle';
import { validateQuery } from '../middlewares/validate';
import { Action, Subject } from '../types/constants';

/**
 * /me is registered before /:id so "me" is never taken as an id. The platform-admin
 * gate runs before CASL, and the service checks platform admin once more.
 */
export function organizationsRoutes(): Router {
  const router = Router();
  router.get(
    '/organizations/me',
    throttle,
    authenticate,
    authorize(Action.READ, Subject.ORGANIZATION),
    organizations.getMine,
  );
  router.get(
    '/organizations',
    throttle,
    authenticate,
    requirePlatformAdmin,
    authorize(Action.READ, Subject.ORGANIZATION),
    validateQuery(ListOrganizationsQueryDto),
    organizations.list,
  );
  router.get(
    '/organizations/:id',
    throttle,
    authenticate,
    requirePlatformAdmin,
    authorize(Action.READ, Subject.ORGANIZATION),
    organizations.getById,
  );
  return router;
}
