import { ENDPOINTS } from '@/constants/endpoints';
import api from '@/services/api';
import type {
    CursorPage,
    CursorQuery,
    Invitation,
    InviteUserRequest,
    InviteUserResponse,
    UpdateRoleRequest,
    User,
} from '@/types/api';

export const usersApi = {
    list: async (query: CursorQuery = {}): Promise<CursorPage<User>> => {
        const { data } = await api.get<CursorPage<User>>(ENDPOINTS.USERS.LIST, { params: query });
        return data;
    },

    /**
     * A well-formed request for a user id belonging to another organisation
     * returns 404, decided by RLS downstream — not by anything here. The SPA
     * shows a not-found state, which is the correct and only thing it can know.
     */
    getById: async (id: string): Promise<User> => {
        const { data } = await api.get<User>(ENDPOINTS.USERS.DETAIL(id));
        return data;
    },

    /**
     * The seat-limit path. A 409 with PLAN_LIMIT_EXCEEDED is an expected outcome
     * here, not a failure of the client — the caller surfaces its message verbatim.
     */
    invite: async (payload: InviteUserRequest): Promise<InviteUserResponse> => {
        const { data } = await api.post<InviteUserResponse>(ENDPOINTS.USERS.INVITE, payload);
        return data;
    },

    updateRole: async (id: string, payload: UpdateRoleRequest): Promise<User> => {
        const { data } = await api.patch<User>(ENDPOINTS.USERS.ROLE(id), payload);
        return data;
    },

    remove: async (id: string): Promise<void> => {
        await api.delete(ENDPOINTS.USERS.DETAIL(id));
    },

    revokeInvitation: async (invitationId: string): Promise<void> => {
        await api.delete(ENDPOINTS.INVITATIONS.REVOKE(invitationId));
    },

    listInvitations: async (): Promise<Invitation[]> => {
        const { data } = await api.get<Invitation[]>(ENDPOINTS.INVITATIONS.LIST);
        return data;
    },
};
