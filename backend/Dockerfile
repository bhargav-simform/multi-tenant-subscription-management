# syntax=docker/dockerfile:1
#
# ONE Dockerfile for all seven backend services, parameterised by SERVICE.
#
# Why one shared file rather than seven: nest-cli.json is a single monorepo
# config in which every service is a `project` built by `nest build <name>`
# from the SAME root tsconfig and the SAME libs/. Seven Dockerfiles would be
# seven byte-identical files differing in one string — and the failure mode of
# that is one of them drifting silently. docker-compose.yml passes the name as
# a build arg instead.
#
# Base image: node:22-alpine, matching package.json's `engines.node: >=22`.
# Pinned to the 22 line (not `latest`) so a rebuild months from now still gets
# the runtime this was verified against; the patch level floats deliberately so
# security fixes land without a code change.

# ─────────────────────────── build stage ───────────────────────────
FROM node:22-alpine AS build

# argon2 is a native module with a prebuild for musl, but pnpm still needs a
# toolchain available if it has to fall back to compiling it. python3/make/g++
# exist only in THIS stage — they never reach the runtime image.
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

# Manifests first, so a source-only change does not invalidate the (slow)
# dependency-install layer. The workspace's apps/*/package.json and
# libs/*/package.json are part of the install graph — pnpm-workspace.yaml
# references them — so they must be present before `pnpm install`.
COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml ./
COPY backend/apps/api-gateway/package.json           apps/api-gateway/
COPY backend/apps/auth-service/package.json          apps/auth-service/
COPY backend/apps/tenant-service/package.json        apps/tenant-service/
COPY backend/apps/user-service/package.json          apps/user-service/
COPY backend/apps/subscription-service/package.json  apps/subscription-service/
COPY backend/apps/resource-service/package.json      apps/resource-service/
COPY backend/apps/audit-service/package.json         apps/audit-service/

# Full install (devDependencies included) — @nestjs/cli and typescript are
# devDependencies and the build cannot run without them.
RUN pnpm install --frozen-lockfile

COPY backend/tsconfig.json backend/nest-cli.json ./
COPY backend/libs ./libs
COPY backend/apps ./apps

ARG SERVICE
RUN test -n "$SERVICE" || (echo "ERROR: build arg SERVICE is required" >&2; exit 1)

# Emits dist/apps/<SERVICE>/apps/<SERVICE>/src/main.js plus
# dist/apps/<SERVICE>/libs/**. Verified: nest build REWRITES every `@app/*`
# import in the emitted JS to a RELATIVE path (e.g. `require("../../../libs/
# database/src")`), so the runtime image needs NO tsconfig-paths, no
# `paths` map, and no libs/ SOURCE — only that compiled tree.
RUN pnpm exec nest build "$SERVICE"

# Production-only dependency tree for the runtime stage. `--prod` prunes the
# existing node_modules in place. Note this keeps pnpm's symlinked .pnpm store
# layout, which is why the runtime stage copies node_modules with -L semantics
# handled by Docker's own COPY (it dereferences into the image correctly since
# both the links and their targets live under /app/node_modules).
#
# CI=true is required, not cosmetic: pnpm refuses to remove a modules directory
# non-interactively without it and aborts with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, which fails the build.
RUN CI=true pnpm prune --prod

# ────────────────────────── runtime stage ──────────────────────────
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

# curl is used by docker-compose.yml's healthchecks to hit /health/ready.
# node:22-alpine ships neither curl nor wget-with-https, and a healthcheck that
# cannot run leaves depends_on: service_healthy waiting forever.
RUN apk add --no-cache curl

WORKDIR /app

ARG SERVICE
ENV SERVICE=${SERVICE}

# Only three things are needed at runtime: the compiled tree, the pruned
# production node_modules, and the root package.json (nothing reads it at
# runtime, but it keeps `node` resolving module type consistently with build).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/apps/${SERVICE} ./dist

# Non-root. The node image ships an unprivileged `node` user; nothing in these
# services writes to the filesystem, so read-only ownership is sufficient.
USER node

# SERVICE is not expanded inside a JSON-form CMD, and the exec form is what
# makes the process PID 1 and therefore able to receive SIGTERM from
# `docker compose down`. sh -c gives the variable expansion; `exec` hands PID 1
# to node rather than leaving a shell in front of it.
CMD ["sh", "-c", "exec node dist/apps/${SERVICE}/src/main.js"]
