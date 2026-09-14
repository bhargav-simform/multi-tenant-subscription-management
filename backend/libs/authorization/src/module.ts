import { Global, Module } from '@nestjs/common';
import { TenantContextModule } from '@app/tenant-context';
import { CaslAbilityFactory } from './factory/casl-ability.factory';
import { CaslAbilityGuard } from './guards/casl-ability.guard';

@Global()
@Module({
  imports: [TenantContextModule],
  providers: [CaslAbilityFactory, CaslAbilityGuard],
  exports: [CaslAbilityFactory, CaslAbilityGuard],
})
export class AuthorizationModule {}
