-- The whole schema in one migration. Merged from the sixteen TypeORM migrations the
-- seven-service backend used to run against five databases; column types, defaults,
-- constraint names, indexes, RLS policies and SECURITY DEFINER functions are the same.
--
-- Differences from the old layout, all consequences of there now being one database:
--   * Everything lives in schema `public` (users.* and subs.* are gone).
--   * consumed_events (x4) is gone — there is no Kafka redelivery to dedupe.
--   * revoked_access_tokens replaces the Redis logout denylist.
--   * Table privileges are granted explicitly per table below instead of through
--     ALTER DEFAULT PRIVILEGES, so the old per-database differences survive the merge:
--     audit tables stay SELECT+INSERT only (append-only), plans stay read-only, and
--     subscriptions keep their old no-DELETE grant.
--
-- Runs as app_migrator (see docker/postgres/init.sh). Never as app_user.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "credentials_status_enum"     AS ENUM ('active', 'disabled');
CREATE TYPE "organizations_status_enum"   AS ENUM ('provisioning', 'active', 'provisioning_failed', 'suspended');
CREATE TYPE "onboarding_sagas_state_enum" AS ENUM ('pending', 'org_created', 'credentials_created', 'subscribed', 'complete');
CREATE TYPE "users_role_enum"             AS ENUM ('org_admin', 'org_member');
CREATE TYPE "users_status_enum"           AS ENUM ('active', 'removed');
CREATE TYPE "plans_code_enum"             AS ENUM ('free', 'pro', 'enterprise');
CREATE TYPE "subscriptions_status_enum"   AS ENUM ('active', 'cancelled');

-- ─────────────────────────────────────────────────────────────────────────────
-- Registry tables (no RLS): identity and organisations
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "organization_id" uuid,                       -- NULL = platform admin
  "email" citext NOT NULL,
  "password_hash" text NOT NULL,
  "status" "credentials_status_enum" NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_credentials_email" UNIQUE ("email")
);
CREATE INDEX "idx_credentials_user_id" ON "credentials" ("user_id");

CREATE TABLE "refresh_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "credential_id" uuid NOT NULL REFERENCES "credentials"("id") ON DELETE CASCADE,
  "token_hash" varchar(64) NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "replaced_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_refresh_tokens_token_hash" UNIQUE ("token_hash")
);
CREATE INDEX "idx_refresh_tokens_credential_id" ON "refresh_tokens" ("credential_id");

-- Access-token denylist for immediate logout (was Redis `platform:denylist:<jti>` with a TTL).
-- expires_at is the token's own exp; rows past it are dead weight and swept hourly.
CREATE TABLE "revoked_access_tokens" (
  "jti" uuid PRIMARY KEY,
  "expires_at" timestamptz NOT NULL
);
CREATE INDEX "idx_revoked_access_tokens_expires_at" ON "revoked_access_tokens" ("expires_at");

CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(255) NOT NULL,
  "slug" varchar(255) NOT NULL,
  "status" "organizations_status_enum" NOT NULL DEFAULT 'provisioning',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_organizations_slug" UNIQUE ("slug")
);
CREATE INDEX "idx_organizations_created_at" ON "organizations" ("created_at" DESC, "id");

CREATE TABLE "onboarding_sagas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" varchar(255) NOT NULL,
  "organization_id" uuid,
  "state" "onboarding_sagas_state_enum" NOT NULL DEFAULT 'pending',
  "admin_email" varchar(255) NOT NULL,
  "admin_user_id" uuid,
  "last_error" text,
  "failed_at" timestamptz,
  "attempts" int NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_onboarding_sagas_idempotency_key" UNIQUE ("idempotency_key")
);
CREATE INDEX "idx_onboarding_sagas_org" ON "onboarding_sagas" ("organization_id");

-- ─────────────────────────────────────────────────────────────────────────────
-- Global reference data (no RLS)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code" "plans_code_enum" NOT NULL,
  "name" varchar(255) NOT NULL,
  "max_users" int NOT NULL,
  "max_storage_bytes" bigint NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  CONSTRAINT "uq_plans_code" UNIQUE ("code")
);

INSERT INTO "plans" (code, name, max_users, max_storage_bytes, is_active) VALUES
  ('free',       'Free',       5,   5368709120,   true),
  ('pro',        'Pro',        25,  53687091200,  true),
  ('enterprise', 'Enterprise', 250, 536870912000, true);

-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant tables (FORCE RLS)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "email" citext NOT NULL,
  "first_name" varchar(255) NOT NULL,
  "last_name" varchar(255) NOT NULL,
  "role" "users_role_enum" NOT NULL,
  "status" "users_status_enum" NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "uq_users_org_email" UNIQUE ("organization_id", "email")
);
CREATE INDEX "idx_users_org_created" ON "users" ("organization_id", "created_at" DESC, "id");

CREATE TABLE "invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "email" citext NOT NULL,
  "role" "users_role_enum" NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "accepted_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "uq_invitations_token_hash" UNIQUE ("token_hash")
);
CREATE INDEX "idx_invitations_org_status" ON "invitations" ("organization_id", "accepted_at", "expires_at");
-- One pending invitation per (org, email). Deliberately ignores expires_at, as before.
CREATE UNIQUE INDEX "uq_invitations_org_email_pending"
  ON "invitations" ("organization_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- One row per organisation. used_seats/used_storage_bytes are the locked counters;
-- the *_snapshot columns copy the plan's limits so a CHECK can enforce them.
CREATE TABLE "subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "plan_id" uuid NOT NULL,
  "status" "subscriptions_status_enum" NOT NULL DEFAULT 'active',
  "used_seats" int NOT NULL DEFAULT 0,
  "max_seats_snapshot" int NOT NULL,
  "used_storage_bytes" bigint NOT NULL DEFAULT 0,
  "max_storage_snapshot" bigint NOT NULL,
  "current_period_end" timestamptz,
  "version" int NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_subscriptions_org" UNIQUE ("organization_id"),
  CONSTRAINT "fk_subscriptions_plan" FOREIGN KEY ("plan_id") REFERENCES "plans"("id"),
  CONSTRAINT "ck_subscriptions_seats" CHECK ("used_seats" <= "max_seats_snapshot"),
  CONSTRAINT "ck_subscriptions_seats_nonneg" CHECK ("used_seats" >= 0),
  CONSTRAINT "ck_subscriptions_storage" CHECK ("used_storage_bytes" <= "max_storage_snapshot"),
  CONSTRAINT "ck_subscriptions_storage_nonneg" CHECK ("used_storage_bytes" >= 0)
);

CREATE TABLE "subscription_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "from_plan_id" uuid,
  "to_plan_id" uuid NOT NULL REFERENCES "plans"("id"),
  "changed_by" uuid NOT NULL,
  "changed_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
CREATE INDEX "idx_subscription_history_org_changed" ON "subscription_history" ("organization_id", "changed_at" DESC);

CREATE TABLE "resources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "description" text,
  "size_bytes" bigint NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "ck_resources_size_nonneg" CHECK ("size_bytes" >= 0)
);
CREATE INDEX "idx_resources_org_created" ON "resources" ("organization_id", "created_at" DESC, "id");
CREATE INDEX "idx_resources_org_size" ON "resources" ("organization_id", "size_bytes" DESC, "id");

-- The storage counter resource creation locks and enforces against.
CREATE TABLE "plan_limit_cache" (
  "organization_id" uuid PRIMARY KEY,
  "max_storage_bytes" bigint NOT NULL,
  "used_storage_bytes" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ck_plan_limit_storage" CHECK ("used_storage_bytes" <= "max_storage_bytes"),
  CONSTRAINT "ck_plan_limit_storage_nonneg" CHECK ("used_storage_bytes" >= 0)
);

-- Standard tenant policy. FORCE so the owner is filtered too; WITH CHECK so a write
-- cannot plant a row in another tenant; NULLIF because set_config(..., true) reverts
-- to '' (not NULL) after commit, and ''::uuid raises on a reused pooled connection.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'invitations', 'subscriptions', 'subscription_history', 'resources', 'plan_limit_cache']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING      (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
        WITH CHECK (organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    $p$, t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit (append-only, FORCE RLS with a NULL-org variant)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_events', 'security_events']
  LOOP
    EXECUTE format($c$
      CREATE TABLE %1$I (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "event_id" uuid NOT NULL,
        "event_type" varchar(100) NOT NULL,
        "organization_id" uuid,
        "actor_user_id" uuid,
        "correlation_id" uuid NOT NULL,
        "severity" varchar(16) NOT NULL,
        "payload" jsonb NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT %2$I UNIQUE ("event_id"),
        CONSTRAINT %3$I CHECK ("severity" IN ('info', 'warn', 'security'))
      )
    $c$, t, 'uq_' || t || '_event_id', 'ck_' || t || '_severity');

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- A platform-level event (failed login for an unknown email) has no org. Those
    -- rows are visible/writable only while NO org scope is set.
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (
          organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
          OR (organization_id IS NULL AND NULLIF(current_setting('app.current_org', true), '') IS NULL)
        )
        WITH CHECK (
          organization_id = NULLIF(current_setting('app.current_org', true), '')::uuid
          OR (organization_id IS NULL AND NULLIF(current_setting('app.current_org', true), '') IS NULL)
        )
    $p$, t);

    EXECUTE format('CREATE INDEX %I ON %I ("organization_id", "occurred_at" DESC, "id")', 'idx_' || t || '_org_occurred', t);
    EXECUTE format('CREATE INDEX %I ON %I ("correlation_id")', 'idx_' || t || '_correlation', t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Narrow SECURITY DEFINER lookups, owned by app_rls_bypass.
-- FORCE RLS applies to a definer function's owner too, so only a BYPASSRLS owner
-- lets these see across tenants. Each exposes one id or one boolean, never content.
-- ─────────────────────────────────────────────────────────────────────────────

-- Login role lookup: which org does this user belong to (before any scope exists)?
CREATE FUNCTION "get_user_organization_id"(p_user_id uuid)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT organization_id FROM users WHERE id = p_user_id; $$;

-- Cross-tenant probe detection for GET /users/:id.
CREATE FUNCTION "user_exists"(p_user_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM users WHERE id = p_user_id); $$;

-- Invitation acceptance: which org does this (unauthenticated) token belong to?
CREATE FUNCTION "get_invitation_organization_id"(p_token_hash varchar(64))
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT organization_id FROM invitations
    WHERE token_hash = p_token_hash
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now();
$$;

-- Platform-admin usage view: counters only, across every org.
CREATE FUNCTION "get_usage_aggregates"(p_organization_id uuid DEFAULT NULL)
RETURNS TABLE (
  organization_id uuid,
  plan_code "plans_code_enum",
  used_seats int,
  max_seats int,
  used_storage_bytes bigint,
  max_storage_bytes bigint
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT sub.organization_id, plan.code, sub.used_seats, sub.max_seats_snapshot,
         sub.used_storage_bytes, sub.max_storage_snapshot
  FROM subscriptions sub
  JOIN plans plan ON plan.id = sub.plan_id
  WHERE p_organization_id IS NULL OR sub.organization_id = p_organization_id;
$$;

-- Cross-tenant probe detection for GET/DELETE /resources/:id. Does not filter deleted_at.
CREATE FUNCTION "resource_exists"(p_resource_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM resources WHERE id = p_resource_id); $$;

GRANT SELECT ON "users", "invitations", "subscriptions", "plans", "resources" TO app_rls_bypass;

ALTER FUNCTION "get_user_organization_id"(uuid)                 OWNER TO app_rls_bypass;
ALTER FUNCTION "user_exists"(uuid)                              OWNER TO app_rls_bypass;
ALTER FUNCTION "get_invitation_organization_id"(varchar(64))    OWNER TO app_rls_bypass;
ALTER FUNCTION "get_usage_aggregates"(uuid)                     OWNER TO app_rls_bypass;
ALTER FUNCTION "resource_exists"(uuid)                          OWNER TO app_rls_bypass;

REVOKE ALL ON FUNCTION "get_user_organization_id"(uuid)              FROM PUBLIC;
REVOKE ALL ON FUNCTION "user_exists"(uuid)                           FROM PUBLIC;
REVOKE ALL ON FUNCTION "get_invitation_organization_id"(varchar(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION "get_usage_aggregates"(uuid)                  FROM PUBLIC;
REVOKE ALL ON FUNCTION "resource_exists"(uuid)                       FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "get_user_organization_id"(uuid)              TO app_user;
GRANT EXECUTE ON FUNCTION "user_exists"(uuid)                           TO app_user;
GRANT EXECUTE ON FUNCTION "get_invitation_organization_id"(varchar(64)) TO app_user;
GRANT EXECUTE ON FUNCTION "get_usage_aggregates"(uuid)                  TO app_user;
GRANT EXECUTE ON FUNCTION "resource_exists"(uuid)                       TO app_user;

-- ─────────────────────────────────────────────────────────────────────────────
-- app_user table privileges (DML only; never DDL)
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "credentials", "refresh_tokens", "revoked_access_tokens",
  "organizations", "onboarding_sagas",
  "users", "invitations", "subscription_history",
  "resources", "plan_limit_cache"
TO app_user;
GRANT SELECT, INSERT, UPDATE ON "subscriptions" TO app_user;
GRANT SELECT ON "plans" TO app_user;
-- Append-only: no UPDATE, no DELETE — history cannot be rewritten by the app.
GRANT SELECT, INSERT ON "audit_events", "security_events" TO app_user;
