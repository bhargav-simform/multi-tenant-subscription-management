import { Router } from 'express';
import { auditRoutes } from './audit.routes';
import { authRoutes } from './auth.routes';
import { dashboardRoutes } from './dashboard.routes';
import { healthRoutes } from './health.routes';
import { invitationsRoutes } from './invitations.routes';
import { onboardingRoutes } from './onboarding.routes';
import { organizationsRoutes } from './organizations.routes';
import { plansRoutes } from './plans.routes';
import { resourcesRoutes } from './resources.routes';
import { subscriptionsRoutes } from './subscriptions.routes';
import { usageRoutes } from './usage.routes';
import { usersRoutes } from './users.routes';

/**
 * Everything under /api/v1. Public routes (no authenticate): POST /auth/login,
 * POST /auth/refresh, POST /onboarding/signup, POST /invitations/:token/accept, and
 * the two health probes. Every other route requires a valid access token.
 */
export function apiRouter(): Router {
  const router = Router();
  router.use(healthRoutes());
  router.use(authRoutes());
  router.use(onboardingRoutes());
  router.use(invitationsRoutes());
  router.use(organizationsRoutes());
  router.use(usersRoutes());
  router.use(plansRoutes());
  router.use(subscriptionsRoutes());
  router.use(usageRoutes());
  router.use(resourcesRoutes());
  router.use(auditRoutes());
  router.use(dashboardRoutes());
  return router;
}
