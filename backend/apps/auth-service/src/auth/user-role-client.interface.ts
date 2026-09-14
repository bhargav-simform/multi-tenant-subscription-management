export const USER_ROLE_CLIENT = Symbol('USER_ROLE_CLIENT');

/**
 * §9.2, §11.2: auth-service -> user-service, synchronous, at login/refresh.
 * Role is user-service's data (`users.role`) — auth-service never caches it,
 * so a promotion/demotion takes effect on the very next login rather than
 * waiting for an eventually-consistent event to land.
 */
export interface IUserRoleClient {
  /** Returns null if the user row doesn't exist yet (e.g. mid-onboarding). */
  getRole(userId: string): Promise<string | null>;
}
