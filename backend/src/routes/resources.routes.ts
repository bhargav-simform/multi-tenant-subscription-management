import { Router } from 'express';
import * as resources from '../controllers/resources.controller';
import { CreateResourceDto, ListResourcesQueryDto } from '../dtos/resources.dto';
import { authenticate } from '../middlewares/authenticate';
import { authorize } from '../middlewares/authorize';
import { throttle } from '../middlewares/throttle';
import { parseUuidParam, validateBody, validateQuery } from '../middlewares/validate';
import { Action, Subject } from '../types/constants';

export function resourcesRoutes(): Router {
  const router = Router();
  router.post(
    '/resources',
    throttle,
    authenticate,
    authorize(Action.CREATE, Subject.RESOURCE),
    validateBody(CreateResourceDto),
    resources.create,
  );
  router.get(
    '/resources',
    throttle,
    authenticate,
    authorize(Action.READ, Subject.RESOURCE),
    validateQuery(ListResourcesQueryDto),
    resources.list,
  );
  router.get(
    '/resources/:id',
    throttle,
    authenticate,
    authorize(Action.READ, Subject.RESOURCE),
    parseUuidParam('id'),
    resources.getById,
  );
  router.delete(
    '/resources/:id',
    throttle,
    authenticate,
    authorize(Action.DELETE, Subject.RESOURCE),
    parseUuidParam('id'),
    resources.remove,
  );
  return router;
}
