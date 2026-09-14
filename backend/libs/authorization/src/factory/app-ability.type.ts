import type { Ability } from '@casl/ability';
import type { Action, Subject } from '@app/common';

/**
 * The ability type used everywhere in the system. Subjects are checked by their
 * string tag (Subject enum), not by class — this keeps the ability factory
 * decoupled from any specific service's entity classes (§12.2).
 */
export type AppSubjects = Subject | 'all';
export type AppAbility = Ability<[Action, AppSubjects]>;
