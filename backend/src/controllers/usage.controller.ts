import type { Request, Response } from 'express';
import type { UsageAggregateQueryDto } from '../dtos/usage.dto';
import * as usageService from '../services/usage.service';

/** GET /usage — platform admins only: per-organisation counters, never content. */
export async function aggregate(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as UsageAggregateQueryDto;
  res.status(200).json(await usageService.getAggregates(query.organizationId));
}
