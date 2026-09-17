import { ENDPOINTS } from '@/constants/endpoints';
import api from '@/services/api';
import type { DashboardResponse } from '@/types/api';

export const dashboardApi = {
    /** One request instead of a waterfall — the gateway's single aggregate route. */
    get: async (): Promise<DashboardResponse> => {
        const { data } = await api.get<DashboardResponse>(ENDPOINTS.DASHBOARD.ROOT);
        return data;
    },
};
