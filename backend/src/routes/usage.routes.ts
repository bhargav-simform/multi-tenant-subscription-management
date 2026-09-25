import { Router } from 'express';
import * as usage from '../controllers/usage.controller';
import { UsageAggregateQueryDto } from '../dtos/usage.dto';
import { authenticate } from '../middlewares/authenticate';
import { requirePlatformAdmin } from '../middlewares/authorize';
import { throttle } from '../middlewares/throttle';
import { validateQuery } from '../middlewares/validate';

/**
 * The platform-admin gate is load-bearing: there is no ability check behind it, so
 * without it any org member could read every organisation's usage.
 */
export function usageRoutes(): Router {
  const router = Router();
  router.get(
    '/usage',
    throttle,
    authenticate,
    requirePlatformAdmin,
    validateQuery(UsageAggregateQueryDto),
    usage.aggregate,
  );
  return router;
}
