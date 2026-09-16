import 'reflect-metadata';
import * as argon2 from 'argon2';
import dataSource from './data-source';

/**
 * §27.3 seed data: "one platform admin", loaded by the same one-shot migrator
 * container so `docker compose up` is genuinely sufficient.
 *
 * WHAT A PLATFORM ADMIN ACTUALLY IS, and why this script is only ~40 lines:
 * there is no separate table and no user row. AuthService.resolveRoles (see
 * apps/auth-service/src/auth/auth.service.ts) derives the role entirely from
 * one column —
 *
 *     if (credential.organizationId === null) return [Role.PLATFORM_ADMIN];
 *
 * — so a platform admin IS a `credentials` row with organization_id NULL.
 * Deliberately there is no user-service row: users.users.organization_id is
 * NOT NULL, and a platform admin belongs to no organisation by definition.
 * resolveRoles never calls the user-service role lookup for this branch, so
 * nothing downstream needs one either.
 *
 * WHY A SCRIPT AND NOT A MIGRATION: a migration with a hardcoded argon2 hash
 * would bake a fixed password into version control, and a migration cannot
 * read PLATFORM_ADMIN_PASSWORD from the environment at deploy time in any
 * reviewable way. This script uses the SAME argon2id parameters auth-service
 * itself uses (kept in sync manually below — auth-service hardcodes these
 * rather than reading the documented ARGON2_* env vars; that pre-existing
 * mismatch is out of scope here, so this file matches the CODE, which is what
 * actually verifies the password at login).
 *
 * IDEMPOTENT: re-running it on an already-seeded database is a no-op, which is
 * what makes `docker compose up` safe to run twice.
 */

// Mirrors ARGON2_OPTIONS in apps/auth-service/src/auth/auth.service.ts. If that
// constant ever changes, this must change with it — otherwise the seeded
// admin's hash is still VERIFIABLE (argon2 encodes its params in the hash
// string), it is merely produced with different cost parameters.
const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

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

  await dataSource.initialize();
  try {
    // citext column — the UNIQUE constraint is already case-insensitive, so
    // this existence check matches login's own lookup semantics exactly.
    const existing: unknown[] = await dataSource.query(
      `SELECT id FROM credentials WHERE email = $1`,
      [email],
    );
    if (existing.length > 0) {
      console.log(`[seed] platform admin ${email} already exists — nothing to do`);
      return;
    }

    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

    // organization_id NULL is the whole point (§11.3): it is what makes
    // resolveRoles return PLATFORM_ADMIN. user_id is minted here exactly as
    // auth-service mints it in createCredentials — auth-service is the source
    // of truth for a user id (see CreateCredentialsDto's note).
    const [row] = await dataSource.query<{ id: string; user_id: string }[]>(
      `INSERT INTO credentials (user_id, organization_id, email, password_hash, status)
       VALUES (gen_random_uuid(), NULL, $1, $2, 'active')
       RETURNING id, user_id`,
      [email, passwordHash],
    );

    console.log(`[seed] platform admin created: ${email} (user_id=${row.user_id})`);
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err: unknown) => {
  console.error('[seed] platform admin seeding FAILED:', err);
  process.exit(1);
});
