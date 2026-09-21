/**
 * Wire types — one per backend DTO, named after it.
 *
 * These mirror the DTO classes under each backend service. Where a field is
 * nullable in the DTO it is nullable here; where a DTO sends `Date`, JSON delivers an ISO string, so
 * these say `string`.
 */

// ── auth-service ────────────────────────────────────────────────────────────
export interface SessionUser {
    id: string;
    email: string;
    roles: string[];
    /** NULL is what makes a caller a platform admin — see resolveRoles. */
    organizationId: string | null;
}

export interface LoginResponse {
    accessToken: string;
    refreshToken: string;
    user: SessionUser;
}

export interface LoginRequest {
    email: string;
    password: string;
}

export interface RefreshResponse {
    accessToken: string;
    refreshToken: string;
}

// ── tenant-service ──────────────────────────────────────────────────────────
export interface SignupRequest {
    organizationName: string;
    adminEmail: string;
    adminPassword: string;
    adminFirstName: string;
    adminLastName: string;
    idempotencyKey: string;
}

export interface SignupResponse {
    organizationId: string;
    organizationName: string;
    status: string;
}

export interface Organization {
    id: string;
    name: string;
    slug: string;
    status: string;
}

// ── user-service ────────────────────────────────────────────────────────────
export interface User {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    status: string;
}

export interface InviteUserRequest {
    email: string;
    role: string;
}

/** A pending invitation, shown in the Users table alongside registered users with an "Invited" status. */
export interface Invitation {
    id: string;
    email: string;
    role: string;
    expiresAt: string;
    createdAt: string;
}

export interface InviteUserResponse {
    invitationId: string;
    /** Development convenience — the raw token, so an invite can be walked through without a mail server. */
    tokenForDev?: string;
}

export interface AcceptInvitationRequest {
    firstName: string;
    lastName: string;
    password: string;
}

export interface UpdateRoleRequest {
    role: string;
}

// ── subscription-service ────────────────────────────────────────────────────
export interface Plan {
    id: string;
    code: string;
    name: string;
    maxUsers: number;
    maxStorageBytes: number;
}

export interface Subscription {
    planCode: string;
    planName: string;
    status: string;
    usedSeats: number;
    maxSeats: number;
    usedStorageBytes: number;
    maxStorageBytes: number;
}

export interface ChangePlanRequest {
    planCode: string;
}

/** Platform-admin aggregate. Counts only — no content, by design. */
export interface UsageAggregate {
    organizationId: string;
    planCode: string;
    usedSeats: number;
    maxSeats: number;
    usedStorageBytes: number;
    maxStorageBytes: number;
}

// ── resource-service ────────────────────────────────────────────────────────
export interface Resource {
    id: string;
    name: string;
    description: string | null;
    sizeBytes: number;
    createdBy: string;
    createdAt: string;
}

export interface CreateResourceRequest {
    name: string;
    description?: string;
    sizeBytes: number;
}

// ── audit-service ───────────────────────────────────────────────────────────
export type AuditSeverity = 'info' | 'warning' | 'security' | 'critical';

export interface AuditEventMetadata {
    id: string;
    eventId: string;
    eventType: string;
    organizationId: string | null;
    actorUserId: string | null;
    correlationId: string;
    severity: AuditSeverity;
    occurredAt: string;
}

export interface AuditEvent extends AuditEventMetadata {
    payload: Record<string, unknown>;
}

// ── api-gateway ─────────────────────────────────────────────────────────────
/** The one aggregate route. The gateway combines without inspecting. */
export interface DashboardResponse {
    subscription: Subscription;
    recentUsers: CursorPage<User> | User[];
}

// ── pagination ──────────────────────────────────────────────────────────────
/**
 * Keyset cursor pagination, matching the server. `nextCursor` is null on the
 * last page. Never fetch-all-and-filter: both the organisation list and the
 * per-organisation resource list must stay usable as they grow.
 */
export interface CursorPage<T> {
    items: T[];
    nextCursor: string | null;
}

export interface CursorQuery {
    cursor?: string;
    limit?: number;
}
