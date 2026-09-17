import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { PAGE_SIZE, STALE_TIME } from '@/constants/common';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { platformAuditApi } from '@/services/audit/auditApi';
import { platformAdminApi } from '@/services/organizations/organizationsApi';

/**
 * PLATFORM-ADMIN HOOKS. Imported only by the admin feature.
 *
 * Everything reachable from here is metadata: organisation names, plans, seat and
 * byte counts, and security-event envelopes. There is no hook in this file that
 * returns an organisation's content, because the gateway exposes no route that
 * would serve it.
 */
export const useAdminOrganizations = (cursor?: string, limit: number = PAGE_SIZE.DEFAULT) =>
    useQuery({
        queryKey: QUERY_KEYS.ADMIN.ORGANIZATIONS(cursor, limit),
        queryFn: () => platformAdminApi.listOrganizations({ ...(cursor ? { cursor } : {}), limit }),
        staleTime: STALE_TIME.ONE_MINUTE,
        placeholderData: keepPreviousData,
    });

export const useAdminOrganization = (id: string | undefined) =>
    useQuery({
        queryKey: QUERY_KEYS.ADMIN.ORGANIZATION_DETAIL(id ?? ''),
        queryFn: () => platformAdminApi.getOrganization(id!),
        enabled: Boolean(id),
        staleTime: STALE_TIME.ONE_MINUTE,
    });

/** Aggregate usage — counts only, for every organisation or one named one. */
export const useAdminUsage = (organizationId?: string) =>
    useQuery({
        queryKey: QUERY_KEYS.ADMIN.USAGE(organizationId),
        queryFn: () => platformAdminApi.getUsage(organizationId),
        staleTime: STALE_TIME.ONE_MINUTE,
    });

/** Cross-tenant access attempts and other security-severity events. */
export const useSecurityEvents = (cursor?: string, limit: number = PAGE_SIZE.DEFAULT) =>
    useQuery({
        queryKey: QUERY_KEYS.AUDIT.SECURITY(cursor, limit),
        queryFn: () => platformAuditApi.listSecurity({ ...(cursor ? { cursor } : {}), limit }),
        staleTime: STALE_TIME.THIRTY_SECONDS,
        placeholderData: keepPreviousData,
    });
