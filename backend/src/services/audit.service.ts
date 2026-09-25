import { contextStore } from '../lib/context-store';
import { ForbiddenException } from '../lib/http-errors';
import { runGlobal, transaction, transactionForOrganization } from '../lib/tenant-db';
import * as auditRecords from '../models/audit-record.model';
import type {
  AuditPageQuery,
  AuditRecord,
  CreateAuditRecordData,
} from '../models/audit-record.model';
import { Role } from '../types/constants';
import type { CursorPage } from '../types/pagination';

export interface AuditListing {
  page: CursorPage<AuditRecord>;
  /** true = platform admin view; the controller strips payloads. */
  metadataOnly: boolean;
}

function isPlatformAdminContext(): boolean {
  const ctx = contextStore.getOrThrow();
  return ctx.roles.includes(Role.PLATFORM_ADMIN) && ctx.organizationId === null;
}

/** The org id for the org-scoped listing; a context without one is a bug (500), as before. */
function requireOrganizationId(): string {
  const organizationId = contextStore.getOrThrow().organizationId;
  if (organizationId === null) {
    throw new Error('Audit listing used from a platform-admin context (organizationId is null).');
  }
  return organizationId;
}

/**
 * GET /audit. An org admin reads their own org's trail, payloads included. A platform
 * admin reads unscoped with no org filter and gets metadata only — and because the
 * transaction is unscoped, RLS limits that to NULL-org (platform-level) rows.
 */
export async function listAuditEvents(query: AuditPageQuery): Promise<AuditListing> {
  if (isPlatformAdminContext()) {
    const page = await runGlobal((tx) => auditRecords.listPage(tx, 'audit', query, null));
    return { page, metadataOnly: true };
  }
  const organizationId = requireOrganizationId();
  const page = await transaction((tx) => auditRecords.listPage(tx, 'audit', query, organizationId));
  return { page, metadataOnly: false };
}

/** GET /audit/security — platform admins only, full rows. */
export async function listSecurityEvents(query: AuditPageQuery): Promise<CursorPage<AuditRecord>> {
  if (!isPlatformAdminContext()) {
    throw new ForbiddenException('Platform admin access required');
  }
  return runGlobal((tx) => auditRecords.listPage(tx, 'security', query, null));
}

/**
 * Written by the event-bus sinks. A NULL-org event is inserted unscoped (the only way
 * the NULL-org policy branch admits it); anything else under its own org's scope.
 */
export async function record(
  table: auditRecords.AuditTable,
  data: CreateAuditRecordData,
): Promise<void> {
  if (data.organizationId === null) {
    await runGlobal((tx) => auditRecords.create(tx, table, data));
    return;
  }
  await transactionForOrganization(data.organizationId, (tx) =>
    auditRecords.create(tx, table, data),
  );
}
