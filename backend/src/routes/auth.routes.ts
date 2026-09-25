import { Router } from 'express';
import * as auth from '../controllers/auth.controller';
import { LoginDto, RefreshDto } from '../dtos/auth.dto';
import { anonymous, authenticate } from '../middlewares/authenticate';
import { throttle } from '../middlewares/throttle';
import { validateBody } from '../middlewares/validate';

/** login/refresh are public (strict throttle bucket); logout validates its body itself, after the denylist write. */
export function authRoutes(): Router {
  const router = Router();
  router.post('/auth/login', throttle, anonymous, validateBody(LoginDto), auth.login);
  router.post('/auth/refresh', throttle, anonymous, validateBody(RefreshDto), auth.refresh);
  router.post('/auth/logout', throttle, authenticate, auth.logout);
  return router;
}
