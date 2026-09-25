import type { Request, Response } from 'express';
import type { CreateResourceDto, ListResourcesQueryDto } from '../dtos/resources.dto';
import * as resourcesService from '../services/resources.service';
import { toResourcePageResponse, toResourceResponse } from '../views/resource.view';

/** POST /resources — enforces the storage limit; 409 on breach, 503 before the limit is synced. */
export async function create(req: Request, res: Response): Promise<void> {
  const resource = await resourcesService.create(req.body as CreateResourceDto);
  res.status(201).json(toResourceResponse(resource));
}

/** GET /resources — keyset-paginated, RLS-scoped. */
export async function list(req: Request, res: Response): Promise<void> {
  const page = await resourcesService.listPage(req.validatedQuery as ListResourcesQueryDto);
  res.status(200).json(toResourcePageResponse(page));
}

/** GET /resources/:id — a foreign-tenant id is a 404 identical to a missing one. */
export async function getById(req: Request, res: Response): Promise<void> {
  const resource = await resourcesService.getById(req.params.id as string);
  res.status(200).json(toResourceResponse(resource));
}

/** DELETE /resources/:id — 204; ownership is checked in the service against the loaded row. */
export async function remove(req: Request, res: Response): Promise<void> {
  await resourcesService.remove(req.params.id as string);
  res.status(204).send();
}
