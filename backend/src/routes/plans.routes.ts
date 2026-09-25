import { Router } from 'express';
import * as plans from '../controllers/plans.controller';
import { authenticate } from '../middlewares/authenticate';
import { throttle } from '../middlewares/throttle';

export function plansRoutes(): Router {
  const router = Router();
  router.get('/plans', throttle, authenticate, plans.list);
  return router;
}
