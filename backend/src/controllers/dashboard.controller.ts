import type { Request, Response } from 'express';
import { assertCan } from '../middlewares/authorize';
import * as subscriptionsService from '../services/subscriptions.service';
import * as usersReadService from '../services/users-read.service';
import { Action, Subject } from '../types/constants';

/**
 * GET /dashboard — the one aggregate route: the current subscription and the five
 * most recent users in one response, saving the SPA a request waterfall on its
 * most-visited screen. It combines two results without inspecting either.
 *
 * Each half keeps its own permission check (they used to be two separate
 * downstream calls, each behind its own CASL guard), and a failure in either fails
 * the whole request rather than rendering half a dashboard.
 */
export async function get(_req: Request, res: Response): Promise<void> {
  const [subscription, recentUsers] = await Promise.all([
    (async () => {
      assertCan(Action.READ, Subject.SUBSCRIPTION);
      return subscriptionsService.getCurrent();
    })(),
    (async () => {
      assertCan(Action.READ, Subject.USER);
      return usersReadService.listPage({ limit: 5 });
    })(),
  ]);
  res.status(200).json({ subscription, recentUsers });
}
