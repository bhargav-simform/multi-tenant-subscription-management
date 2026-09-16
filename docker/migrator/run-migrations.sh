#!/usr/bin/env bash
# docs/architecture/ARCHITECTURE.md §27.3: the one-shot `migrator` container's
# entrypoint. Runs every service's migrations as app_migrator, seeds the
# platform admin, and exits. docker-compose.yml holds all seven application
# services behind `condition: service_completed_successfully` on this
# container, so no service ever races a schema.
#
# `set -euo pipefail` matches docker/postgres/init.sh's convention and is
# load-bearing here, not stylistic: without -e a failed migration would be
# logged and the script would march on to the next service, exit 0, and let
# every application service start against a half-created schema. That is the
# single worst failure mode this file can have.
set -euo pipefail

: "${POSTGRES_HOST:?POSTGRES_HOST must be set}"
: "${MIGRATOR_DB_USER:?MIGRATOR_DB_USER must be set}"
: "${MIGRATOR_DB_PASSWORD:?MIGRATOR_DB_PASSWORD must be set}"

POSTGRES_PORT="${POSTGRES_PORT:-5432}"

log() { echo "[migrator] $*"; }

# ── 1. Wait for Postgres ──────────────────────────────────────────────────
# docker-compose.yml already gates this container on `postgres: condition:
# service_healthy`, so this loop should be a no-op. It stays because the
# healthcheck reports the SERVER as ready, while this container additionally
# needs its own ROLE to be usable — and on a very first boot the server accepts
# connections only after /docker-entrypoint-initdb.d/init.sh has finished
# creating that role. Probing as app_migrator, not as the superuser, is what
# makes this check test the thing that actually matters.
log "waiting for postgres at ${POSTGRES_HOST}:${POSTGRES_PORT} as ${MIGRATOR_DB_USER}..."
attempt=0
until PGPASSWORD="$MIGRATOR_DB_PASSWORD" pg_isready \
        --host "$POSTGRES_HOST" --port "$POSTGRES_PORT" \
        --username "$MIGRATOR_DB_USER" --dbname postgres --quiet; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    log "FATAL: postgres not ready after 60 attempts (~120s)"
    exit 1
  fi
  sleep 2
done
log "postgres is ready"

# ── 2. Migrations ─────────────────────────────────────────────────────────
run_migrations() {
  local svc="$1"
  log "── ${svc}: running migrations ──"
  # `pnpm --filter` resolves the workspace package by the `name` in its
  # apps/<svc>/package.json (which matches the directory name for all six).
  pnpm --filter "$svc" migration:run
  log "── ${svc}: migrations complete ──"
}

# These four own their databases outright (§14.1) and share nothing, so their
# relative order is irrelevant. They run sequentially rather than in parallel
# purely so a failure's output is readable — the whole step takes seconds.
run_migrations tenant-service
run_migrations auth-service
run_migrations resource-service
run_migrations audit-service

# §32.3 "Migration sequencing for core_db" — THE ONE ORDERING CONSTRAINT IN
# THIS FILE, and the reason this script exists rather than a `for` loop over a
# directory listing.
#
# user-service and subscription-service share ONE physical database (core_db,
# §14.2) and, unusually, one physical TABLE: user-service's
# CreateUsersAndInvitations CREATEs a minimal subs.subscriptions (the columns
# the §19 seat lock needs), and subscription-service's
# CreatePlansAndExtendSubscriptions later ALTERs it to add plan_id, status,
# used_storage_bytes and the storage CHECKs. Reversing these two lines does not
# produce a warning — it produces `relation "subs.subscriptions" does not
# exist` and a failed migrator.
run_migrations user-service
run_migrations subscription-service

# ── 3. Seed data (§27.3) ──────────────────────────────────────────────────
#
# THREE PLANS: already seeded, and NOT re-seeded here. subscription-service's
# CreatePlansAndExtendSubscriptions migration INSERTs free/pro/enterprise
# directly (see the `§22.3 seed data / §27.3` block in that file), which is the
# better home for them: the plan catalogue is schema-shaped reference data with
# a UNIQUE constraint on `code`, it must exist before the FK from
# subs.subscriptions can ever be satisfied, and being inside the migration
# makes it automatically idempotent via the migrations ledger. Verified against
# a real container: `SELECT code FROM subs.plans` returns exactly three rows
# after migrations, with no seeding step at all.
#
# ONE PLATFORM ADMIN: genuinely not creatable by any existing code path, so it
# needs this step. A platform admin is a `credentials` row with
# organization_id NULL (that single column is what makes
# AuthService.resolveRoles return PLATFORM_ADMIN) and NO user-service row —
# users.users.organization_id is NOT NULL and a platform admin belongs to no
# organisation. The seed script uses the same argon2id parameters auth-service
# itself uses rather than a hardcoded hash, and is idempotent on re-run.
if [ -n "${PLATFORM_ADMIN_PASSWORD:-}" ]; then
  log "── seeding platform admin ──"
  pnpm --filter auth-service seed:platform-admin
else
  # Not fatal. A deployment that has already seeded its admin, or one that
  # provisions the account by some other means, should not be blocked from
  # migrating — but silence here would be a confusing way to end up with no way
  # to log in, so say so.
  log "PLATFORM_ADMIN_PASSWORD not set — SKIPPING platform admin seed."
  log "  No platform-admin account will exist. Set it in .env to seed one."
fi

log "all migrations and seeds complete"
