#!/usr/bin/env bash
# docs/architecture/ARCHITECTURE.md §27.2: run once on first Postgres boot via
# the official image's /docker-entrypoint-initdb.d/ mechanism. A shell script
# (not raw SQL) so role passwords come from environment variables rather than
# being hardcoded into a checked-in file.
set -euo pipefail

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"
: "${MIGRATOR_DB_PASSWORD:?MIGRATOR_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  -- ── Databases (§14.1) ────────────────────────────────────────────────
  CREATE DATABASE auth_db;
  CREATE DATABASE tenant_db;
  CREATE DATABASE core_db;      -- user-service (schema: users) + subscription-service (schema: subs) — §14.2
  CREATE DATABASE resource_db;
  CREATE DATABASE audit_db;

  -- ── Roles (§13.5, §22.1) ─────────────────────────────────────────────
  -- app_migrator: DDL only, used exclusively by the one-shot migrator container.
  CREATE ROLE app_migrator WITH LOGIN PASSWORD '${MIGRATOR_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS CREATEDB;

  -- app_user: DML only, used by every running service. NOSUPERUSER + NOBYPASSRLS
  -- is the load-bearing part — this is what §13.8's startup check verifies on
  -- every service boot, and what makes RLS structurally unbypassable by
  -- application code (§13.5, §13.6).
  CREATE ROLE app_user WITH LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS;

  -- app_rls_bypass (§13.6, §32.4): NOLOGIN — nothing ever connects AS this
  -- role, and no application code, credential, or connection string
  -- references it. It exists SOLELY to be the OWNER of a small, named set of
  -- narrow SECURITY DEFINER lookup functions (one row, one boolean or one id
  -- column, never general content) on FORCE-protected tables.
  --
  -- This is not a stylistic choice. FORCE ROW LEVEL SECURITY applies its
  -- policy to the table owner too — that is the entire point of FORCE — and
  -- Postgres extends that to a SECURITY DEFINER function's effective owner:
  -- a function owned by app_migrator (or any NOBYPASSRLS role) still has the
  -- policy applied inside it, silently returning nothing instead of
  -- bypassing RLS (confirmed empirically; Postgres's own error message when
  -- attempting to work around this points at exactly one fix: give the
  -- owner BYPASSRLS). Without this role, EVERY narrow cross-tenant lookup
  -- function in this codebase (users.get_user_organization_id,
  -- subs.get_usage_aggregates, resource_exists, users.user_exists) silently
  -- returns nothing instead of the one row/column it is meant to expose —
  -- this is what broke auth-service's login role lookup in production
  -- before this fix (§32.4).
  --
  -- BYPASSRLS on this role is safe DESPITE the name: it is never a login
  -- role, so no CREDENTIAL can ever connect as it directly. It does not
  -- weaken app_user's own guarantee — app_user stays NOBYPASSRLS everywhere,
  -- unchanged, and §13.8's startup check verifies THAT role, not this one.
  --
  -- CORRECTION to an earlier draft of this comment: this role's capability
  -- is not limited to "being the owner of specific functions" in practice —
  -- app_migrator is GRANTed membership in it below (required for
  -- ALTER FUNCTION ... OWNER TO to succeed at all: Postgres requires the
  -- current user to be a MEMBER of the target role, not merely to hold
  -- schema privileges — confirmed empirically; without this grant every
  -- migration that transfers a function's ownership aborts with
  -- "must be able to SET ROLE"). That membership means app_migrator itself
  -- COULD `SET ROLE app_rls_bypass` and read across every tenant. This is
  -- accepted: app_migrator is a one-shot, DDL-only credential used solely by
  -- the migrator container, never a runtime credential a running service
  -- holds, and it already has unrestricted DDL over every table it owns.
  -- app_user — the credential every running service actually connects as —
  -- has NO membership in app_rls_bypass and cannot SET ROLE to it; that is
  -- the guarantee that actually matters, and it is unaffected.
  CREATE ROLE app_rls_bypass WITH NOLOGIN NOSUPERUSER BYPASSRLS;
  GRANT app_rls_bypass TO app_migrator;
EOSQL

# ── CREATE ON DATABASE for app_migrator (all five databases) ──────────────
#
# BUG FIX (found empirically while wiring the one-shot migrator container):
# without this, auth-service's and user-service's very first migration abort
# with `permission denied to create extension "citext"`, and NO schema is ever
# created. Both call `CREATE EXTENSION IF NOT EXISTS citext` (auth-service also
# pgcrypto) for their case-insensitive email columns.
#
# citext and pgcrypto are both `trusted` extensions in PostgreSQL 17 (verified:
# pg_available_extensions.trusted = t for both), which means a NON-superuser
# may install them — but only if that role holds CREATE on the database. These
# databases are owned by `postgres` (CREATE DATABASE above runs as the
# superuser), so app_migrator inherited no database-level CREATE at all. Every
# grant below this point is SCHEMA-level (GRANT ALL ON SCHEMA public), which is
# a different privilege and does not cover CREATE EXTENSION.
#
# This is the narrowest fix: CREATE on the database lets app_migrator install a
# trusted extension and create schemas — both things its migrations already do
# — and nothing more. It does not touch app_user, which remains DML-only,
# NOSUPERUSER and NOBYPASSRLS; §13.8's startup check is unaffected.
grant_database_create() {
  local db="$1"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    GRANT CREATE ON DATABASE "${db}" TO app_migrator;
EOSQL
}

grant_database_create auth_db
grant_database_create tenant_db
grant_database_create core_db
grant_database_create resource_db
grant_database_create audit_db

grant_standard_schema() {
  local db="$1"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
    GRANT ALL ON SCHEMA public TO app_migrator;
    GRANT USAGE ON SCHEMA public TO app_user;
    -- §13.6, §32.4: app_rls_bypass needs USAGE/CREATE on the schema so
    -- app_migrator can transfer ownership of a narrow lookup function to it
    -- (ALTER FUNCTION ... OWNER TO requires the target role to have
    -- privileges on the containing schema) — a per-database grant, since
    -- schema privileges do not span databases even though the role itself
    -- is cluster-wide.
    GRANT ALL ON SCHEMA public TO app_rls_bypass;
    ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
    ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO app_user;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL
}

grant_standard_schema auth_db
grant_standard_schema tenant_db
grant_standard_schema resource_db

# audit_db: append-only (§8.7). app_user gets SELECT + INSERT but NEVER
# UPDATE/DELETE — no code path in audit-service is granted the ability to
# rewrite history. Deliberately its own grant block, not
# grant_standard_schema(), because that helper's ALTER DEFAULT PRIVILEGES
# grants UPDATE+DELETE too, which this database must never have.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname audit_db <<-EOSQL
  GRANT ALL ON SCHEMA public TO app_migrator;
  GRANT USAGE ON SCHEMA public TO app_user;
  -- §13.6, §32.4: audit_events/security_events are RLS-protected with a
  -- nullable organization_id (a platform-level security event, e.g. a failed
  -- login before any org context exists, has none) — audit-service's own
  -- migration defines a policy variant for this, but app_rls_bypass still
  -- needs schema access here for the same reason as every other database, in
  -- case a future narrow lookup function is added in this schema.
  GRANT ALL ON SCHEMA public TO app_rls_bypass;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
    GRANT SELECT, INSERT ON TABLES TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app_user;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL

# core_db: two schemas, one per service, plus this init grants the schema-level
# access both services need. The ONE additional cross-schema TABLE grant that
# makes the §19 seat-enforcement transaction possible — app_user's SELECT/UPDATE
# on subs.subscriptions — is applied by user-service's own migration (it is the
# one that creates the table and the one that needs the grant; see
# docs/architecture/ARCHITECTURE.md §32.3 "Migration sequencing for core_db"),
# not here, so it stays reviewable as an explicit, dated change alongside the
# table it applies to.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname core_db <<-EOSQL
  CREATE SCHEMA IF NOT EXISTS users AUTHORIZATION app_migrator;
  CREATE SCHEMA IF NOT EXISTS subs  AUTHORIZATION app_migrator;
  GRANT USAGE ON SCHEMA users TO app_user;
  GRANT USAGE ON SCHEMA subs  TO app_user;
  -- §13.6, §32.4: same reasoning as grant_standard_schema — needed so
  -- ownership of users.get_user_organization_id/user_exists and
  -- subs.get_usage_aggregates can be transferred to app_rls_bypass.
  GRANT ALL ON SCHEMA users TO app_rls_bypass;
  GRANT ALL ON SCHEMA subs  TO app_rls_bypass;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA users
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA users
    GRANT USAGE, SELECT ON SEQUENCES TO app_user;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  -- NO "ALTER DEFAULT PRIVILEGES ... IN SCHEMA subs ..." here, deliberately.
  -- §14.2: app_user (user-service's runtime role, also connecting to core_db)
  -- gets SELECT/UPDATE on subs.subscriptions ONLY — never blanket CRUD on
  -- every table subscription-service will ever create in subs. That one
  -- narrow grant is applied by user-service's own migration, on the one
  -- table it names explicitly (see CreateUsersAndInvitations migration).
  -- subscription-service's runtime role gets its own full grants on subs,
  -- applied when subscription-service's migration/init runs.
EOSQL
