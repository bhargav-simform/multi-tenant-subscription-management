import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CursorPage, CursorQuery } from '@app/common';
import { TenantContextStore } from '@app/tenant-context';
import { Organization } from './organization.entity';
import {
  ORGANIZATION_REPOSITORY,
  type IOrganizationRepository,
} from './organization.repository.interface';

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: IOrganizationRepository,
    private readonly tenantContext: TenantContextStore,
  ) {}

  /**
   * §13.3: the org is NEVER named by the caller — it comes from the token's
   * organizationId claim only. There is deliberately no GET /organizations/:id
   * route for org admins/members; "my organisation" is always this method.
   */
  async getMyOrganization(): Promise<Organization> {
    const ctx = this.tenantContext.getOrThrow();
    if (!ctx.organizationId) {
      // A platform admin has no "my organisation" — calling this is a bug in
      // the caller, not a legitimate empty result.
      throw new NotFoundException();
    }
    const org = await this.organizations.findById(ctx.organizationId);
    if (!org) throw new NotFoundException();
    return org;
  }

  /**
   * §13.6, §8.3: Platform Admin ONLY. `organizations` is deliberately NOT an
   * RLS table (§8.3) — it is the registry, not tenant content — so unlike
   * every RLS-protected resource in the system, there is no database-level
   * backstop here. CASL's @CheckAbility(READ, Organization) at the controller
   * only proves the caller may read AN organisation of SOME kind; it cannot
   * express "only your own" as a type-level check (CASL conditions require a
   * loaded instance to evaluate, and this method's whole point is that no
   * single instance is being loaded — see §12.5's documented pattern, applied
   * here explicitly rather than left to the guard).
   *
   * This explicit check IS the enforcement for this one non-RLS table. Do not
   * remove it on the assumption CASL or a future RLS policy covers it.
   */
  async listOrganizations(query: CursorQuery): Promise<CursorPage<Organization>> {
    this.requirePlatformAdmin();
    return this.organizations.listPage(query);
  }

  /**
   * §13.6, §8.3: same reasoning as listOrganizations. An org admin/member has
   * no route to this method at all in the API design (§8.3's route table) —
   * this check is defence in depth against a future route wiring it up
   * carelessly, exactly the mistake §13.7 exists to catch even off the RLS path.
   */
  async getOrganizationById(id: string): Promise<Organization> {
    this.requirePlatformAdmin();
    const org = await this.organizations.findById(id);
    if (!org) throw new NotFoundException();
    return org;
  }

  private requirePlatformAdmin(): void {
    if (!this.tenantContext.isPlatformAdmin()) {
      throw new ForbiddenException('Platform admin access required');
    }
  }
}
