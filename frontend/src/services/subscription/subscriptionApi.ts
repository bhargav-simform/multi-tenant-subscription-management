import { ENDPOINTS } from '@/constants/endpoints';
import api from '@/services/api';
import type { ChangePlanRequest, Plan, Subscription } from '@/types/api';

export const subscriptionApi = {
    /** The plan catalogue is global, not tenant data — any authenticated caller. */
    listPlans: async (): Promise<Plan[]> => {
        const { data } = await api.get<Plan[]>(ENDPOINTS.SUBSCRIPTIONS.PLANS);
        return data;
    },

    /** No id in the path — "current" means the caller's own, read from the token. */
    getCurrent: async (): Promise<Subscription> => {
        const { data } = await api.get<Subscription>(ENDPOINTS.SUBSCRIPTIONS.CURRENT);
        return data;
    },

    /** A downgrade is a limit path: it is refused if current usage exceeds the new plan. */
    changePlan: async (payload: ChangePlanRequest): Promise<Subscription> => {
        const { data } = await api.post<Subscription>(ENDPOINTS.SUBSCRIPTIONS.CHANGE, payload);
        return data;
    },
};
