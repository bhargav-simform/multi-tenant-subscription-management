import { ENDPOINTS } from '@/constants/endpoints';
import api from '@/services/api';
import type { CursorPage, CursorQuery, Organization, UsageAggregate } from '@/types/api';

/** Any authenticated role — the caller's own organisation, named by the token. */
export const organizationsApi = {
    getMine: async (): Promise<Organization> => {
        const { data } = await api.get<Organization>(ENDPOINTS.ORGANIZATIONS.ME);
        return data;
    },
};

/**
 * PLATFORM ADMIN ONLY. Kept in its own object, and imported only by the admin
 * feature, so that a tenant screen cannot reach these by autocomplete. Everything
 * here is metadata — organisation name, plan, counts. No call in this module can
 * return an organisation's content, because no such route exists to call.
 */
export const platformAdminApi = {
    listOrganizations: async (query: CursorQuery = {}): Promise<CursorPage<Organization>> => {
        const { data } = await api.get<CursorPage<Organization>>(ENDPOINTS.ORGANIZATIONS.LIST, { params: query });
        return data;
    },

    getOrganization: async (id: string): Promise<Organization> => {
        const { data } = await api.get<Organization>(ENDPOINTS.ORGANIZATIONS.DETAIL(id));
        return data;
    },

    /** Aggregate counts across organisations — seats and bytes, never rows. */
    getUsage: async (organizationId?: string): Promise<UsageAggregate[]> => {
        const { data } = await api.get<UsageAggregate[] | UsageAggregate>(ENDPOINTS.SUBSCRIPTIONS.USAGE, {
            params: organizationId ? { organizationId } : undefined,
        });
        return Array.isArray(data) ? data : [data];
    },
};
