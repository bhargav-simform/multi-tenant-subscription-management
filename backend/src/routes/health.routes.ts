import { Router } from 'express';
import * as health from '../controllers/health.controller';

/** Public and unthrottled: they return booleans, no tenant data. */
export function healthRoutes(): Router {
  const router = Router();
  router.get('/health', health.liveness);
  router.get('/health/ready', health.readiness);
  return router;
}
