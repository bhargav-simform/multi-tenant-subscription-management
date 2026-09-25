import type { Request, Response } from 'express';
import type { ChangePlanDto } from '../dtos/subscriptions.dto';
import * as subscriptionsService from '../services/subscriptions.service';

/** GET /subscriptions/current — the caller's own; "current" comes from the token, never a path id. */
export async function current(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await subscriptionsService.getCurrent());
}

/** POST /subscriptions/change — 201 with the updated subscription; 409 when usage exceeds the target plan. */
export async function change(req: Request, res: Response): Promise<void> {
  const { planCode } = req.body as ChangePlanDto;
  res.status(201).json(await subscriptionsService.changePlan(planCode));
}
