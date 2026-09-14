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
EOSQL

grant_standard_schema() {
  local db="$1"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
    GRANT ALL ON SCHEMA public TO app_migrator;
    GRANT USAGE ON SCHEMA public TO app_user;
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

# audit_db: append-only. app_user gets SELECT + INSERT but never UPDATE/DELETE —
# no code path in audit-service is granted the ability to rewrite history.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname audit_db <<-EOSQL
  GRANT ALL ON SCHEMA public TO app_migrator;
  GRANT USAGE ON SCHEMA public TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
    GRANT SELECT, INSERT ON TABLES TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO app_user;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL

# core_db: two schemas, one per service, plus this init grants the schema-level
# access both services need. The ONE additional cross-schema TABLE grant that
# makes the §19 seat-enforcement transaction possible (user-service reading
# subs.subscriptions) is applied by subscription-service's own migration, once
# that table exists — not here, so it stays reviewable as an explicit, dated change.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname core_db <<-EOSQL
  CREATE SCHEMA IF NOT EXISTS users AUTHORIZATION app_migrator;
  CREATE SCHEMA IF NOT EXISTS subs  AUTHORIZATION app_migrator;
  GRANT USAGE ON SCHEMA users TO app_user;
  GRANT USAGE ON SCHEMA subs  TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA users
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA users
    GRANT USAGE, SELECT ON SEQUENCES TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA subs
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
  ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA subs
    GRANT USAGE, SELECT ON SEQUENCES TO app_user;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL
