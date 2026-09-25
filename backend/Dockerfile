# syntax=docker/dockerfile:1
#
# The backend: one Express process. Build context is the repo root (see
# docker-compose.yml), so paths below are prefixed with backend/.

# ─────────────────────────── build stage ───────────────────────────
FROM node:22-alpine AS build

# argon2 is a native module; the toolchain is only needed if pnpm has to compile
# it, and it never reaches the runtime image.
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

# Manifests first so a source-only change keeps the dependency layer cached.
COPY backend/package.json backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY backend/tsconfig.json backend/tsconfig.build.json backend/prisma.config.ts ./
COPY backend/prisma ./prisma
COPY backend/src ./src

# prisma generate writes the client into src/generated, then tsc compiles it with the rest.
RUN pnpm run build

# CI=true: pnpm refuses to prune node_modules non-interactively without it.
RUN CI=true pnpm prune --prod

# ────────────────────────── runtime stage ──────────────────────────
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

# curl for the docker-compose healthcheck.
RUN apk add --no-cache curl

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist

# Non-root; the process writes nothing to disk.
USER node

EXPOSE 3000
CMD ["node", "dist/src/server.js"]
