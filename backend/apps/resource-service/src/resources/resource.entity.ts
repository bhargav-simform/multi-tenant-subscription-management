import { Entity, Column, Index } from 'typeorm';
import { TenantBaseEntity, bigintTransformer } from '@app/database';

/**
 * §8.6: the tenant-owned business resource, and the direct target of the
 * brief's sharpest test (§13.1) — a user of Org A must not be able to read an
 * Org B resource by id, even through a query with no WHERE clause at all.
 *
 * Bare `@Entity('resources')` with NO `schema:` option, unlike
 * user-service's and subscription-service's entities: this service owns
 * `resource_db` outright (§14.1), so its tables live in the default `public`
 * schema and Postgres's default search_path ("$user", public) resolves them.
 * The `schema: 'users'` / `schema: 'subs'` settings those services' DataSources
 * carry exist ONLY because they share one physical `core_db` (§14.2) and their
 * tables therefore live in non-default schemas that search_path excludes;
 * auth-service and tenant-service, which also own dedicated single-schema
 * databases, likewise set no `schema` option. Adding one here would be cargo
 * cult, and would break resolution rather than fix it.
 *
 * Extends TenantBaseEntity (§15.2), which is what makes this a tenant-owned
 * table: organization_id, the RLS policy applied in the creating migration
 * (§13.5), and registration in TENANT_TABLES (§13.8) all follow from it.
 */
@Entity('resources')
@Index(['organizationId', 'createdAt', 'id'])
@Index(['organizationId', 'sizeBytes', 'id'])
export class Resource extends TenantBaseEntity {
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /**
   * §15.1: `bigint` MUST carry bigintTransformer. TypeORM's pg driver returns
   * bigint columns as JavaScript STRINGS regardless of this field's `number`
   * annotation — without the transformer, `currentUsed + sizeBytes` in the
   * storage-limit check (§19.6) would silently become string concatenation
   * ("1000" + 500 === "1000500"), and the comparison against the limit would
   * be lexicographic. This exact defect already bit subscription-service.
   */
  @Column({ name: 'size_bytes', type: 'bigint', transformer: bigintTransformer })
  sizeBytes!: number;

  /**
   * §12.3: the user who created this resource. CASL's ORG_MEMBER rules grant
   * UPDATE/DELETE only where `createdBy` equals the acting user id — that
   * condition is evaluated in the service against the loaded row (see
   * check-ability.decorator.ts: @CheckAbility checks the SUBJECT TYPE only,
   * never conditions, because only the service has the row).
   */
  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;
}
