import type { Request, Response } from 'express';
import * as plansService from '../services/plans.service';
import { toPlanResponse } from '../views/plan.view';

/** GET /plans — the active plan catalogue. Any authenticated caller; no ability check. */
export async function list(_req: Request, res: Response): Promise<void> {
  const plans = await plansService.listActive();
  res.status(200).json(plans.map(toPlanResponse));
}
