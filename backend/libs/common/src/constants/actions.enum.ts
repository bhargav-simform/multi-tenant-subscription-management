/** CASL actions (§12.2). Never pass raw strings to @CheckAbility(). */
export enum Action {
  CREATE = 'create',
  READ = 'read',
  UPDATE = 'update',
  DELETE = 'delete',
  MANAGE = 'manage',
}
