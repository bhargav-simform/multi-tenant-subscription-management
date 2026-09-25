import type { Invitation } from '../models/invitation.model';

export interface InvitationResponse {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
  createdAt: Date;
}

export function toInvitationResponse(invitation: Invitation): InvitationResponse {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  };
}
