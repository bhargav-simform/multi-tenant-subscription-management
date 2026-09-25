import { randomUUID } from 'node:crypto';
import { CreateCredentialsDto } from '../dtos/auth.dto';
import { publish } from '../lib/events';
import { hashPassword } from '../lib/hashing';
import { ConflictException } from '../lib/http-errors';
import { runGlobal } from '../lib/tenant-db';
import { validateDto } from '../middlewares/validate';
import * as credentials from '../models/credential.model';
import { EVENT_TYPES, TOPICS } from '../types/events';

/**
 * Creates the login for a new user — the onboarding saga's first admin and an
 * accepted invitation. The userId is minted HERE and carried in
 * UserCredentialsCreated, so the users row is created with the SAME id.
 *
 * Formerly an internal HTTP endpoint whose body was validated at that boundary; the
 * same DTO is validated here so a bad email or short password still fails with the
 * same 400, which callers then map exactly as they mapped the HTTP error.
 */
export async function createCredentials(input: {
  organizationId?: string;
  email: string;
  password: string;
}): Promise<{ userId: string }> {
  const dto = await validateDto(CreateCredentialsDto, input);
  const userId = randomUUID();
  const passwordHash = await hashPassword(dto.password);

  try {
    await runGlobal((tx) =>
      credentials.create(tx, {
        userId,
        organizationId: dto.organizationId ?? null,
        email: dto.email,
        passwordHash,
      }),
    );
  } catch (err) {
    if (err instanceof credentials.EmailTakenError) {
      throw new ConflictException(err.message);
    }
    throw err;
  }

  await publish(TOPICS.USER, {
    eventType: EVENT_TYPES.USER_CREDENTIALS_CREATED,
    organizationId: dto.organizationId ?? null,
    actorUserId: null,
    payload: { userId, email: dto.email },
  });

  return { userId };
}
