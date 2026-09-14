export const AUTH_CLIENT = Symbol('AUTH_CLIENT');

/**
 * §9.2: tenant-service -> auth-service is synchronous REST (internal), because
 * the saga must know credential creation succeeded before advancing (§11.3).
 * Implemented by an HTTP client bound in InfrastructureModule; a fake
 * implementation backs the saga's unit tests.
 */
export interface IAuthClient {
  createCredentials(data: {
    organizationId: string;
    email: string;
    password: string;
  }): Promise<{ userId: string }>;
}
