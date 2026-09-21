export const AUTH_CLIENT = Symbol('AUTH_CLIENT');

/** Mirrors tenant-service's onboarding AUTH_CLIENT — same internal endpoint, same contract. */
export interface IAuthClient {
  createCredentials(data: {
    organizationId: string;
    email: string;
    password: string;
  }): Promise<{ userId: string }>;
}
