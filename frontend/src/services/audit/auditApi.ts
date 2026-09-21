import { ENDPOINTS } from '@/constants/endpoints';
import api from '@/services/api';
import type { AuditEvent, AuditEventMetadata, CursorPage, CursorQuery } from '@/types/api';

export interface ListAuditEventsQuery extends CursorQuery {
    /** Exact match, e.g. "UserInvited" — same scoped read, filtered server-side. */
    eventType?: string;
}

export const auditApi = {
    /**
     * Audit records arrive at audit-service over Kafka and only over Kafka, so
     * there is no write route here — by design, no service can be persuaded to
     * skip writing its trail.
     */
    list: async (query: ListAuditEventsQuery = {}): Promise<CursorPage<AuditEvent>> => {
        const { data } = await api.get<CursorPage<AuditEvent>>(ENDPOINTS.AUDIT.LIST, { params: query });
        return data;
    },
};

/**
 * PLATFORM ADMIN ONLY — security-severity events, including cross-tenant access
 * attempts. This is the production tenant-leak signal, so it is reachable from
 * the admin shell and nowhere else. audit-service enforces the role itself.
 */
export const platformAuditApi = {
    listSecurity: async (query: CursorQuery = {}): Promise<CursorPage<AuditEventMetadata>> => {
        const { data } = await api.get<CursorPage<AuditEventMetadata>>(ENDPOINTS.AUDIT.SECURITY, { params: query });
        return data;
    },
};
