import { Client } from 'pg';
import { buildDatabaseUrl } from '../src/config/env';
import { hashPassword } from '../src/lib/hashing';

/**
 * Seeds the one platform admin, run by the migrator after `prisma migrate deploy`.
 *
 * A platform admin is nothing more than a `credentials` row with organization_id
 * NULL — that NULL is what makes auth resolve PLATFORM_ADMIN — and deliberately has
 * no users row (users.organization_id is NOT NULL).
 *
 * A script, not a migration, so the password comes from PLATFORM_ADMIN_PASSWORD at
 * deploy time instead of a hash baked into version control. Idempotent: re-running
 * on a seeded database is a no-op.
 */
async function main(): Promise<void> {
  const email = process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@platform.local';
  const password = process.env.PLATFORM_ADMIN_PASSWORD;

  if (!password || password.length < 12) {
    throw new Error(
      'PLATFORM_ADMIN_PASSWORD must be set and at least 12 characters ' +
        '(matching CreateCredentialsDto @MinLength(12)). Refusing to seed a ' +
        'platform administrator with a weak or default password.',
    );
  }

  const client = new Client({
    connectionString: buildDatabaseUrl(
      'MIGRATOR_DB_USER',
      'MIGRATOR_DB_PASSWORD',
      'MIGRATOR_DATABASE_URL',
    ),
  });
  await client.connect();
  try {
    // citext: this matches login's own case-insensitive lookup.
    const existing = await client.query('SELECT id FROM credentials WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      console.log(`[seed] platform admin ${email} already exists — nothing to do`);
      return;
    }

    // Same argon2id parameters login verifies with (lib/hashing).
    const passwordHash = await hashPassword(password);

    const { rows } = await client.query<{ id: string; user_id: string }>(
      `INSERT INTO credentials (user_id, organization_id, email, password_hash, status)
       VALUES (gen_random_uuid(), NULL, $1, $2, 'active')
       RETURNING id, user_id`,
      [email, passwordHash],
    );

    console.log(`[seed] platform admin created: ${email} (user_id=${rows[0].user_id})`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('[seed] platform admin seeding FAILED:', err);
  process.exit(1);
});
