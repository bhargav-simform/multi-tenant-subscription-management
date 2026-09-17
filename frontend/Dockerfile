# syntax=docker/dockerfile:1
#
# Two-stage build: compile the SPA with pnpm + Vite, then serve the static
# output with a minimal nginx. Matches backend/Dockerfile's shape (pnpm,
# frozen lockfile, manifests copied first) so the two Dockerfiles in this repo
# read the same way even though a static SPA has no runtime Node process.
#
# Base image: node:22-alpine, matching package.json's engines.node: >=20.

# ─────────────────────────── build stage ───────────────────────────
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Manifest first, so a source-only change does not invalidate the (slow)
# dependency-install layer.
COPY frontend/package.json frontend/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY frontend/ ./

# VITE_API_BASE_URL is baked into the JS bundle at build time (Vite inlines
# import.meta.env at build, not at container start) — passed as a build arg so
# compose can supply it from the shared .env without a second env file.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

RUN pnpm build

# ─────────────────────────── runtime stage ───────────────────────────
FROM nginx:1.27-alpine AS runtime

# Nest services get a curl-based healthcheck; this image needs the same tool
# available for compose's healthcheck to exec into the container with.
RUN apk add --no-cache curl

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 5173

HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=10s \
    CMD curl -fsS http://localhost:5173/ || exit 1
