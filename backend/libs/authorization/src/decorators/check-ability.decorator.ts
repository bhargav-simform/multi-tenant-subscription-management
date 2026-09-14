import { SetMetadata } from '@nestjs/common';
import type { Action, Subject } from '@app/common';

export interface RequiredAbility {
  action: Action;
  subject: Subject;
}

export const CHECK_ABILITY_KEY = 'checkAbility';

/**
 * Declares the coarse permission a route requires (§12.5). This checks the
 * SUBJECT TYPE only — e.g. "can this role ever update a User". Subject-CONDITION
 * checks (e.g. "...this specific user, in this org") happen in the application
 * service after the row is loaded, via ability.can(action, subject('User', loaded))
 * — because only the service has the loaded row, and RLS has already scoped it.
 */
export const CheckAbility = (action: Action, subject: Subject) =>
  SetMetadata(CHECK_ABILITY_KEY, { action, subject } satisfies RequiredAbility);
