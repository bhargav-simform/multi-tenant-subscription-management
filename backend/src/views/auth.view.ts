import type { AuthSession } from '../services/auth.service';

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    roles: string[];
    organizationId: string | null;
  };
}

/** Login and refresh share this body. `user.id` is the domain user id, never the credential id. */
export function toLoginResponse(session: AuthSession): LoginResponse {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    user: {
      id: session.credential.userId,
      email: session.credential.email,
      roles: session.roles,
      organizationId: session.credential.organizationId,
    },
  };
}
