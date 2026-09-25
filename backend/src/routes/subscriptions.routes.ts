import { Router } from 'express';
import * as subscriptions from '../controllers/subscriptions.controller';
import { ChangePlanDto } from '../dtos/subscriptions.dto';
import { authenticate } from '../middlewares/authenticate';
import { authorize } from '../middlewares/authorize';
import { throttle } from '../middlewares/throttle';
import { validateBody } from '../middlewares/validate';
import { Action, Subject } from '../types/constants';

/** GET /plans lives in plans.routes.ts. */
export function subscriptionsRoutes(): Router {
  const router = Router();
  router.get(
    '/subscriptions/current',
    throttle,
    authenticate,
    authorize(Action.READ, Subject.SUBSCRIPTION),
    subscriptions.current,
  );
  router.post(
    '/subscriptions/change',
    throttle,
    authenticate,
    authorize(Action.UPDATE, Subject.SUBSCRIPTION),
    validateBody(ChangePlanDto),
    subscriptions.change,
  );
  return router;
}
