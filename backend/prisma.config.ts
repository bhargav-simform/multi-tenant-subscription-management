import { defineConfig } from 'prisma/config';
import { buildDatabaseUrl } from './src/config/env';

/**
 * Prisma CLI config. The CLI (migrate deploy / status) runs as app_migrator; the
 * running app never uses this file — it connects as app_user (src/lib/prisma.ts).
 * `prisma generate` needs no database, so a missing URL is tolerated there.
 */
function migratorUrl(): string {
  try {
    return buildDatabaseUrl('MIGRATOR_DB_USER', 'MIGRATOR_DB_PASSWORD', 'MIGRATOR_DATABASE_URL');
  } catch {
    return '';
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: migratorUrl() },
});
