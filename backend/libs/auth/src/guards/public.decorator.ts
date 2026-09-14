import { SetMetadata } from '@nestjs/common';

/**
 * Same metadata key as @app/tenant-context's Public() (§11.5) — a route marked
 * public is public for BOTH the JWT guard (gateway) and the internal-context
 * guard (downstream services), because it is the same three routes either way.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
