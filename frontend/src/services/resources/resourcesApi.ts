import { ENDPOINTS } from '@/constants/endpoints';
import api from '@/services/api';
import type { CreateResourceRequest, CursorPage, CursorQuery, Resource } from '@/types/api';

export const resourcesApi = {
    list: async (query: CursorQuery = {}): Promise<CursorPage<Resource>> => {
        const { data } = await api.get<CursorPage<Resource>>(ENDPOINTS.RESOURCES.LIST, { params: query });
        return data;
    },

    /**
     * THE cross-tenant test target (H1). Asking for another organisation's resource
     * by a perfectly well-formed id returns 404, and it returns 404 because
     * PostgreSQL row-level security filtered the row out before resource-service's
     * query ever saw it — not because a `WHERE organization_id = …` was remembered.
     */
    getById: async (id: string): Promise<Resource> => {
        const { data } = await api.get<Resource>(ENDPOINTS.RESOURCES.DETAIL(id));
        return data;
    },

    /** The storage-limit path — a 409 here carries a specific, showable message. */
    create: async (payload: CreateResourceRequest): Promise<Resource> => {
        const { data } = await api.post<Resource>(ENDPOINTS.RESOURCES.CREATE, payload);
        return data;
    },

    remove: async (id: string): Promise<void> => {
        await api.delete(ENDPOINTS.RESOURCES.DETAIL(id));
    },
};
