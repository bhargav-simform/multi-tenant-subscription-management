import { Global, Module } from '@nestjs/common';
import { TenantContextStore } from './store/tenant-context.store';
import { InternalContextSigner } from './store/internal-context.signer';
import { InternalContextGuard } from './guards/internal-context.guard';
import { TenantContextMiddleware } from './middleware/tenant-context.middleware';

/**
 * @Global so every feature module can inject TenantContextStore without importing
 * this module explicitly. Registered once in AppModule per service.
 */
@Global()
@Module({
  providers: [
    TenantContextStore,
    InternalContextSigner,
    InternalContextGuard,
    TenantContextMiddleware,
  ],
  exports: [TenantContextStore, InternalContextSigner, InternalContextGuard, TenantContextMiddleware],
})
export class TenantContextModule {}
