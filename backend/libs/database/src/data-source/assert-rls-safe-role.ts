import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * §13.8 check #2 / §22.2: on service startup, assert the connected role cannot
 * bypass RLS. Refuse to boot otherwise — a misconfigured deployment (e.g.
 * connecting as the table owner, or as a superuser) must fail closed, not
 * silently disable the isolation guarantee this whole architecture rests on.
 */
export async function assertRlsSafeRole(dataSource: DataSource): Promise<void> {
  const logger = new Logger('assertRlsSafeRole');

  const [row] = await dataSource.query<
    { rolsuper: boolean; rolbypassrls: boolean; rolname: string }[]
  >(`
    SELECT rolname, rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `);

  if (!row) {
    throw new Error(`Could not resolve current_user role for RLS safety check`);
  }

  if (row.rolsuper) {
    throw new Error(
      `FATAL: database role "${row.rolname}" is a superuser. Superusers bypass Row-Level ` +
        `Security entirely (§13.5). This service refuses to start with this role — connect ` +
        `as app_user instead.`,
    );
  }

  if (row.rolbypassrls) {
    throw new Error(
      `FATAL: database role "${row.rolname}" has BYPASSRLS. This service refuses to start — ` +
        `the tenant isolation guarantee in §13.5 depends on this role being unable to bypass RLS.`,
    );
  }

  logger.log(`RLS safety check passed: role "${row.rolname}" is non-superuser, NOBYPASSRLS`);
}
