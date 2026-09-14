import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TenantContextStore } from './store/tenant-context.store';
import { InternalContextSigner } from './store/internal-context.signer';
import { InternalContextGuard } from './guards/internal-context.guard';
import { TenantContextMiddleware } from './middleware/tenant-context.middleware';
import { InternalHttpClient } from './http/internal-http.client';

/**
 * @Global so every feature module can inject TenantContextStore (and
 * InternalHttpClient — §9.4) without importing this module explicitly.
 * Registered once in AppModule per service.
 */
@Global()
@Module({
  imports: [HttpModule],
  providers: [
    TenantContextStore,
    InternalContextSigner,
    InternalContextGuard,
    TenantContextMiddleware,
    InternalHttpClient,
  ],
  exports: [
    TenantContextStore,
    InternalContextSigner,
    InternalContextGuard,
    TenantContextMiddleware,
    InternalHttpClient,
  ],
})
export class TenantContextModule {}
