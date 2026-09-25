import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { env } from '../config/env';

let client: PrismaClient | undefined;

/**
 * The one PrismaClient, connected as app_user (DML only, NOBYPASSRLS). Created on
 * first use so importing a model/service never opens a pool by itself.
 *
 * Do not query through this directly for tenant data — go through lib/tenant-db.ts,
 * which is what sets app.current_org and therefore what makes RLS filter anything.
 */
export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.databaseUrl }) });
  }
  return client;
}

/** For tests: point the singleton at a specific client (e.g. a Testcontainers database). */
export function setPrisma(next: PrismaClient | undefined): void {
  client = next;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
