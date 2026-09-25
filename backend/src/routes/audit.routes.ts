import { Router } from 'express';
import * as audit from '../controllers/audit.controller';
import { ListAuditQueryDto } from '../dtos/audit.dto';
import { authenticate } from '../middlewares/authenticate';
import { authorize } from '../middlewares/authorize';
import { throttle } from '../middlewares/throttle';
import { validateQuery } from '../middlewares/validate';
import { Action, Subject } from '../types/constants';

export function auditRoutes(): Router {
  const router = Router();
  router.get(
    '/audit',
    throttle,
    authenticate,
    authorize(Action.READ, Subject.AUDIT_EVENT),
    validateQuery(ListAuditQueryDto),
    audit.list,
  );
  router.get(
    '/audit/security',
    throttle,
    authenticate,
    authorize(Action.READ, Subject.AUDIT_EVENT),
    validateQuery(ListAuditQueryDto),
    audit.listSecurity,
  );
  return router;
}
