#!/usr/bin/env bash
# The one-shot `migrator` container's entrypoint: apply migrations as
# app_migrator, seed the platform admin, exit. The backend is held behind
# `condition: service_completed_successfully` on this container.
#
# `set -euo pipefail` is load-bearing: without -e a failed migration would be
# logged, the script would exit 0, and the backend would start against a
# half-created schema.
set -euo pipefail

: "${POSTGRES_HOST:?POSTGRES_HOST must be set}"
: "${MIGRATOR_DB_USER:?MIGRATOR_DB_USER must be set}"
: "${MIGRATOR_DB_PASSWORD:?MIGRATOR_DB_PASSWORD must be set}"

POSTGRES_PORT="${POSTGRES_PORT:-5432}"
DB_NAME="${DB_NAME:-app_db}"

log() { echo "[migrator] $*"; }

# ── 1. Wait for Postgres ──────────────────────────────────────────────────
# Probes as app_migrator, not the superuser: on a first boot the server accepts
# connections before init.sh has finished creating this role.
log "waiting for postgres at ${POSTGRES_HOST}:${POSTGRES_PORT} as ${MIGRATOR_DB_USER}..."
attempt=0
until PGPASSWORD="$MIGRATOR_DB_PASSWORD" pg_isready \
        --host "$POSTGRES_HOST" --port "$POSTGRES_PORT" \
        --username "$MIGRATOR_DB_USER" --dbname "$DB_NAME" --quiet; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    log "FATAL: postgres not ready after 60 attempts (~120s)"
    exit 1
  fi
  sleep 2
done
log "postgres is ready"

# ── 2. Migrations ─────────────────────────────────────────────────────────
# prisma.config.ts builds the app_migrator URL from MIGRATOR_DB_* / POSTGRES_* / DB_NAME.
# The three plans are seeded inside the migration itself.
log "── applying migrations ──"
pnpm exec prisma migrate deploy
log "── migrations complete ──"

# ── 3. Platform admin seed ────────────────────────────────────────────────
# A platform admin is a credentials row with organization_id NULL and no users
# row. Idempotent on re-run.
if [ -n "${PLATFORM_ADMIN_PASSWORD:-}" ]; then
  log "── seeding platform admin ──"
  pnpm run seed:platform-admin
else
  log "PLATFORM_ADMIN_PASSWORD not set — SKIPPING platform admin seed."
  log "  No platform-admin account will exist. Set it in .env to seed one."
fi

log "all migrations and seeds complete"
