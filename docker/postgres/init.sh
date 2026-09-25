#!/usr/bin/env bash
# Runs once on first Postgres boot via the official image's
# /docker-entrypoint-initdb.d/ mechanism. A shell script (not raw SQL) so role
# passwords come from environment variables rather than a checked-in file.
#
# Creates the one application database and the three roles the RLS design rests
# on. Table-level privileges are NOT granted here — the migration grants them per
# table (prisma/migrations/0001_init/migration.sql), which is what keeps the audit
# tables append-only and the plan catalogue read-only for app_user.
set -euo pipefail

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"
: "${MIGRATOR_DB_PASSWORD:?MIGRATOR_DB_PASSWORD must be set}"
DB_NAME="${DB_NAME:-app_db}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE DATABASE "${DB_NAME}";

  -- app_migrator: DDL only, used exclusively by the one-shot migrator container.
  CREATE ROLE app_migrator WITH LOGIN PASSWORD '${MIGRATOR_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS CREATEDB;

  -- app_user: DML only, the role the running backend connects as. NOSUPERUSER +
  -- NOBYPASSRLS is the load-bearing part: the backend verifies it at boot and
  -- refuses to start otherwise, and it is what makes RLS unbypassable from code.
  CREATE ROLE app_user WITH LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS;

  -- app_rls_bypass: NOLOGIN. Exists only to OWN the narrow SECURITY DEFINER lookup
  -- functions (one id or one boolean each). FORCE RLS applies to a definer
  -- function's owner too, so only a BYPASSRLS owner lets those functions see
  -- across tenants. Nothing can connect as this role; app_user is not a member.
  --
  -- app_migrator IS a member: ALTER FUNCTION ... OWNER TO requires membership in
  -- the target role. Accepted — app_migrator is a one-shot DDL credential that is
  -- never held by the running backend.
  CREATE ROLE app_rls_bypass WITH NOLOGIN NOSUPERUSER BYPASSRLS;
  GRANT app_rls_bypass TO app_migrator;

  -- CREATE on the database lets app_migrator install the trusted citext/pgcrypto
  -- extensions its migration needs, and nothing more.
  GRANT CREATE ON DATABASE "${DB_NAME}" TO app_migrator;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB_NAME" <<-EOSQL
  GRANT ALL ON SCHEMA public TO app_migrator;
  GRANT USAGE ON SCHEMA public TO app_user;
  -- Needed so ownership of the lookup functions can be transferred to it.
  GRANT ALL ON SCHEMA public TO app_rls_bypass;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL
