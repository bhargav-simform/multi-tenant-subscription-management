import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Matches the shape ResourceRepository.listPage's sort=sizeBytes branch uses:
 * organization_id leading, then the keyset ordering columns (size_bytes DESC,
 * id) — the same pattern idx_resources_org_created already follows for the
 * default createdAt sort.
 */
export class AddResourceSizeIndex1700000000003 implements MigrationInterface {
  name = 'AddResourceSizeIndex1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "idx_resources_org_size"
        ON "resources" ("organization_id", "size_bytes" DESC, "id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_resources_org_size"`);
  }
}
