import { ForbiddenException, Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantContextStore } from '@app/tenant-context';
import { CaslAbilityFactory } from '../factory/casl-ability.factory';
import { CHECK_ABILITY_KEY, type RequiredAbility } from '../decorators/check-ability.decorator';

/**
 * The real authorization decision (§12.4, §12.5). Runs in every service, after
 * InternalContextGuard + TenantContextMiddleware have established ALS context —
 * reads context from TenantContextStore, NEVER from `req`.
 *
 * A route with no @CheckAbility() metadata is allowed through (authenticated is
 * enough) — use this deliberately, not by omission, for read endpoints scoped
 * entirely by RLS with no role distinction.
 */
@Injectable()
export class CaslAbilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilityFactory: CaslAbilityFactory,
    private readonly tenantContext: TenantContextStore,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RequiredAbility | undefined>(
      CHECK_ABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const ctx = this.tenantContext.getOrThrow();
    const ability = this.abilityFactory.createForContext(ctx);

    if (!ability.can(required.action, required.subject)) {
      throw new ForbiddenException(
        `You do not have permission to ${required.action} ${required.subject}`,
      );
    }
    return true;
  }
}
