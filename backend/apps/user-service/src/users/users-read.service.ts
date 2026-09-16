import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantAwareDataSource } from '@app/database';
import { TenantContextStore } from '@app/tenant-context';
import { EventPublisher } from '@app/kafka';
import { EVENT_TYPES, KAFKA_TOPICS } from '@app/common';
import type { CursorPage, CursorQuery } from '@app/common';
import { USER_REPOSITORY, type IUserRepository } from './user.repository.interface';
import type { UserResponseDto } from './dto/user-response.dto';
import type { User } from './user.entity';

/**
 * Read paths split from UsersService (which owns the seat-limit mutations,
 * §19) — these never touch the subscription row, but they DO still need to
 * run inside a scoped transaction (§13.5, §15.3): `IUserRepository`'s
 * methods fall back to the raw injected `DataSource` when no manager is
 * passed, and `users.users` has FORCE ROW LEVEL SECURITY — a connection with
 * no `app.current_org` set returns zero rows UNCONDITIONALLY, for every
 * organisation, not just a foreign one (§32.4 records this as a real defect,
 * caught here and in UsersService's mutation paths). "Never needs a
 * transaction" was the original, incorrect assumption this class shipped
 * with; every method here now opens one via TenantAwareDataSource purely to
 * get `app.current_org` set, even though nothing here needs the ACID
 * properties of a transaction otherwise.
 */
@Injectable()
export class UsersReadService {
  private readonly logger = new Logger(UsersReadService.name);

  constructor(
    private readonly tenantDataSource: TenantAwareDataSource,
    private readonly tenantContext: TenantContextStore,
    private readonly publisher: EventPublisher,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
  ) {}

  async listPage(query: CursorQuery): Promise<CursorPage<UserResponseDto>> {
    const page = await this.tenantDataSource.transaction((manager) =>
      this.users.listPage(query, manager),
    );
    return { ...page, items: page.items.map(toDto) };
  }

  /**
   * §13, H1: the cross-tenant read-by-ID test target. Scoped via
   * TenantAwareDataSource so `app.current_org` is actually set on the
   * connection (§13.5) — a foreign-tenant id then returns null here exactly
   * as if the row didn't exist, and this method has no way to tell the
   * difference, which is the entire point.
   *
   * §13.9, LAYER 4 (added alongside resource-service, which implements the
   * identical pattern): returning 404 is only half of what §13.2's detection
   * layer requires. The other half is publishing CrossTenantAccessAttempted
   * so audit-service can spot a caller probing ids across tenants — this
   * method 404'd correctly from the start but was silent, so the detector had
   * nothing to detect with. See reportIfCrossTenantAttempt below for why the
   * existence probe is shaped the way it is.
   */
  async getById(id: string): Promise<UserResponseDto> {
    const user = await this.tenantDataSource.transaction((manager) =>
      this.users.findById(id, manager),
    );
    if (!user) {
      await this.reportIfCrossTenantAttempt(id);
      throw new NotFoundException();
    }
    return toDto(user);
  }

  /**
   * §13.9: distinguishes "belongs to another tenant" from "does not exist" —
   * for the SECURITY EVENT ONLY, never for the caller, who gets the same 404
   * either way. A 403 (or any response that differed between the two cases)
   * would be an existence oracle, leaking exactly what isolation protects.
   *
   * The probe is deliberately as narrow as it can be:
   *   - `users.user_exists(uuid)` returns a single boolean — no columns, and
   *     in particular NOT organization_id, so the owning tenant is never
   *     loaded into this process at all and cannot leak into the event or a
   *     log line. audit-service correlates the owning side from its own
   *     records (§13.9).
   *   - It is NOT a plain unscoped query via runGlobal() alone, and being
   *     SECURITY DEFINER is not sufficient on its own either. `users.users`
   *     is FORCE-protected, and FORCE applies the USING policy to the TABLE
   *     OWNER too — Postgres extends that to a SECURITY DEFINER function's
   *     effective owner during execution (confirmed empirically, §32.4). A
   *     function owned by app_migrator (NOBYPASSRLS, like every role before
   *     this fix) gets NO bypass inside it: `organization_id = NULL` is
   *     unknown/false for every row, so an unscoped SELECT — through
   *     runGlobal(), through this function, or otherwise — could never see
   *     ANY user this way. This was a real design flaw, caught empirically by
   *     a reused-connection integration test: the probe never found a row,
   *     for any org, so CrossTenantAccessAttempted never fired.
   *     `user_exists` is owned by `app_rls_bypass` — a NOLOGIN role created
   *     specifically to hold BYPASSRLS for this narrow class of function
   *     (§13.6) — which is what actually bypasses the policy. It is granted
   *     to app_user for EXECUTE only and cannot be used to read anything
   *     about the row except whether its id is taken.
   *
   * Raw SQL rather than a repository method, matching this file's existing
   * style and keeping the query's narrowness visible at the call site —
   * IUserRepository has no single-column existence method, and adding one
   * that reads across tenants would put a cross-tenant-capable method on the
   * ordinary repository interface, which is worse than one auditable query here.
   */
  private async reportIfCrossTenantAttempt(userId: string): Promise<void> {
    try {
      const ctx = this.tenantContext.getOrThrow();

      const existsElsewhere = await this.tenantDataSource.runGlobal(async (manager) => {
        const rows = await manager.query<{ user_exists: boolean }[]>(
          'SELECT users.user_exists($1)',
          [userId],
        );
        return rows[0]?.user_exists ?? false;
      });

      if (!existsElsewhere) return;

      await this.publisher.publish(KAFKA_TOPICS.SECURITY, {
        eventType: EVENT_TYPES.CROSS_TENANT_ACCESS_ATTEMPTED,
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        payload: {
          subjectType: 'User',
          subjectId: userId,
          actorOrganizationId: ctx.organizationId,
          actorUserId: ctx.userId,
        },
      });
    } catch (err) {
      // §32.4: best-effort DETECTION side-channel, never the data path — a
      // probe failure must not turn this endpoint's 404 into anything else.
      this.logger.error(
        `Cross-tenant detection probe failed for user ${userId}: ${(err as Error).message}`,
      );
    }
  }

  /** §9.2, §11.2, §13.6: crosses tenant boundaries by design — see the interface's doc comment. */
  async getRoleForAuthService(userId: string): Promise<{ role: string | null }> {
    const role = await this.users.findRoleByUserId(userId);
    return { role };
  }
}

function toDto(user: User): UserResponseDto {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    status: user.status,
  };
}
