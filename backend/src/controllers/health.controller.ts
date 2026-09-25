import type { Request, Response } from 'express';
import { getPrisma } from '../lib/prisma';

/** Liveness: the process is up. */
export function liveness(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok' });
}

/**
 * Readiness: the database answers. It is the one dependency left, and without it
 * every request fails (the logout denylist fails closed), so a backend that cannot
 * reach it is not ready.
 */
export async function readiness(_req: Request, res: Response): Promise<void> {
  const database = await getPrisma().$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  res.status(200).json({ status: database ? 'ok' : 'degraded', database });
}
