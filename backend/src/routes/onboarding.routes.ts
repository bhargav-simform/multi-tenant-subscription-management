import { Router } from 'express';
import * as onboarding from '../controllers/onboarding.controller';
import { SignupDto } from '../dtos/onboarding.dto';
import { anonymous } from '../middlewares/authenticate';
import { throttle } from '../middlewares/throttle';
import { validateBody } from '../middlewares/validate';

export function onboardingRoutes(): Router {
  const router = Router();
  router.post(
    '/onboarding/signup',
    throttle,
    anonymous,
    validateBody(SignupDto),
    onboarding.signup,
  );
  return router;
}
