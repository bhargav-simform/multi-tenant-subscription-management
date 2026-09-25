import type { Request, Response } from 'express';
import type { ListOrganizationsQueryDto } from '../dtos/organizations.dto';
import * as organizationsService from '../services/organizations.service';
import { toOrganizationPage, toOrganizationResponse } from '../views/organization.view';

/** GET /organizations/me — no id anywhere in the request; the org comes from the token. */
export async function getMine(_req: Request, res: Response): Promise<void> {
  const org = await organizationsService.getMyOrganization();
  res.status(200).json(toOrganizationResponse(org));
}

/** GET /organizations — platform admin only; metadata only. */
export async function list(req: Request, res: Response): Promise<void> {
  const page = await organizationsService.listOrganizations(
    req.validatedQuery as ListOrganizationsQueryDto,
  );
  res.status(200).json(toOrganizationPage(page));
}

/** GET /organizations/:id — platform admin only. No UUID pipe: a malformed id was always a 500. */
export async function getById(req: Request, res: Response): Promise<void> {
  const org = await organizationsService.getOrganizationById(String(req.params.id));
  res.status(200).json(toOrganizationResponse(org));
}
