import type { Credential as PrismaCredential, CredentialStatus } from '../generated/prisma/client';
import { isUniqueViolation } from '../lib/db-errors';
import type { Tx } from '../lib/tenant-db';

export type { CredentialStatus };

/**
 * credentials — the only place a password hash exists. A registry table with no
 * RLS: a credential is looked up by email or id, never listed per organisation.
 * organizationId NULL is what makes an account a platform admin.
 */
export interface Credential {
  id: string;
  userId: string;
  organizationId: string | null;
  email: string;
  passwordHash: string;
  status: CredentialStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Thrown by create() on a unique_violation for `email`. */
export class EmailTakenError extends Error {
  constructor(email: string) {
    super(`Email "${email}" is already registered`);
    this.name = 'EmailTakenError';
  }
}

function toCredential(row: PrismaCredential): Credential {
  return {
    id: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    email: row.email,
    passwordHash: row.passwordHash,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** citext column, so this matches case-insensitively, like the unique constraint. */
export async function findByEmail(db: Tx, email: string): Promise<Credential | null> {
  const row = await db.credential.findUnique({ where: { email } });
  return row ? toCredential(row) : null;
}

export async function findByUserId(db: Tx, userId: string): Promise<Credential | null> {
  const row = await db.credential.findFirst({ where: { userId } });
  return row ? toCredential(row) : null;
}

/** By this row's OWN id — what refresh_tokens.credential_id references, never the userId. */
export async function findById(db: Tx, id: string): Promise<Credential | null> {
  const row = await db.credential.findUnique({ where: { id } });
  return row ? toCredential(row) : null;
}

/** The unique constraint on email is the guarantee — never a check-then-write. */
export async function create(
  db: Tx,
  data: { userId: string; organizationId: string | null; email: string; passwordHash: string },
): Promise<Credential> {
  try {
    return toCredential(await db.credential.create({ data }));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new EmailTakenError(data.email);
    }
    throw err;
  }
}
