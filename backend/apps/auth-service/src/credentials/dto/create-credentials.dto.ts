import { IsEmail, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

/**
 * §8.2: called only by tenant-service's onboarding saga (internal, never
 * client-facing). NOTE: does NOT accept a userId — auth-service MINTS the
 * userId at credential-creation time and returns it (see
 * CreateCredentialsResponseDto). This resolves a real ordering question: the
 * user row in user-service does not exist yet when this runs (it is created
 * later, asynchronously, when user-service reacts to OrganizationProvisioned
 * — §8.4 "consumes"). auth-service is the earliest point at which this
 * identity exists, so it is the one source of truth for the id, carried
 * forward in the UserCredentialsCreated event payload for user-service to use
 * as the primary key of the row IT creates.
 *
 * organizationId is optional — a platform admin credential (created by a
 * separate, not-yet-built platform-provisioning path) would have none,
 * matching §11.3's nullable organizationId.
 */
export class CreateCredentialsDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12)
  password!: string;
}
