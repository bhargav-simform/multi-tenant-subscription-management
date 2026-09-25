import type { Request, Response } from 'express';
import type { ListAuditQueryDto } from '../dtos/audit.dto';
import * as auditService from '../services/audit.service';
import { mapPage, toAuditMetadataResponse, toAuditResponse } from '../views/audit.view';

/** GET /audit — org admins: own org, full rows. Platform admins: metadata only. */
export async function list(req: Request, res: Response): Promise<void> {
  const { page, metadataOnly } = await auditService.listAuditEvents(
    req.validatedQuery as ListAuditQueryDto,
  );
  res.status(200).json(mapPage(page, metadataOnly ? toAuditMetadataResponse : toAuditResponse));
}

/** GET /audit/security — platform admins only. */
export async function listSecurity(req: Request, res: Response): Promise<void> {
  const page = await auditService.listSecurityEvents(req.validatedQuery as ListAuditQueryDto);
  res.status(200).json(mapPage(page, toAuditResponse));
}
