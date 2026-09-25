import { Router } from 'express';
import * as dashboard from '../controllers/dashboard.controller';
import { authenticate } from '../middlewares/authenticate';
import { throttle } from '../middlewares/throttle';

export function dashboardRoutes(): Router {
  const router = Router();
  router.get('/dashboard', throttle, authenticate, dashboard.get);
  return router;
}
