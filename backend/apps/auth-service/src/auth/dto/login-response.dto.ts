export class LoginResponseDto {
  accessToken!: string;
  refreshToken!: string;
  user!: {
    id: string;
    email: string;
    roles: string[];
    organizationId: string | null;
  };
}
