import type { ForcedSubject, MongoAbility } from '@casl/ability';
import type { Action, Subject } from '@app/common';

/**
 * The ability type used everywhere in the system. Subjects are checked by their
 * string tag (Subject enum), not by class — this keeps the ability factory
 * decoupled from any specific service's entity classes (§12.2).
 *
 * `MongoAbility`, not the plain `Ability` this used to alias — CaslAbilityFactory
 * passes field-condition objects as `can()`'s third argument (e.g.
 * `{ organizationId: ctx.organizationId }`), and evaluating those conditions is
 * exactly what MongoAbility's built-in conditions matcher does. Plain `Ability`
 * has no matcher configured by default and throws "Cannot restrict access by
 * conditions without a conditionsMatcher option" the first time such a rule is
 * checked — which is every non-platform-admin CASL check in this system, so this
 * was a 500 on every request that reached CaslAbilityGuard's real decision path.
 */

/**
 * Each subject's real field shape, tagged with `ForcedSubject` so CASL's
 * `InstanceOf<T, S>` — which infers a condition's allowed shape from the
 * SPECIFIC subject literal being checked, e.g. `Subject.RESOURCE` — has an
 * actual object type to build `MongoQuery<...>` conditions against, instead of
 * a bare string carrying no fields. A tag alone (`ForcedSubject<Subject.X>`
 * with no other properties) still resolves conditions to a fieldless object
 * and every real condition below would fail to compile the same way plain
 * `Subject.X` did — the fields must be listed here explicitly, once per
 * subject, matching exactly what CaslAbilityFactory's `can()` calls use.
 */
type OrganizationInstance = { id: string } & ForcedSubject<Subject.ORGANIZATION>;
type UserInstance = { id: string; organizationId: string } & ForcedSubject<Subject.USER>;
type SubscriptionInstance = { organizationId: string } & ForcedSubject<Subject.SUBSCRIPTION>;
type ResourceInstance = { organizationId: string; createdBy: string } & ForcedSubject<Subject.RESOURCE>;
type AuditEventInstance = { organizationId: string } & ForcedSubject<Subject.AUDIT_EVENT>;

export type AppSubjects =
  | Subject.ORGANIZATION
  | OrganizationInstance
  | Subject.USER
  | UserInstance
  | Subject.SUBSCRIPTION
  | SubscriptionInstance
  | Subject.PLAN
  | Subject.RESOURCE
  | ResourceInstance
  | Subject.AUDIT_EVENT
  | AuditEventInstance
  | 'all';

export type AppAbility = MongoAbility<[Action, AppSubjects]>;
