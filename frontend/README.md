# Frontend

React SPA for the multi-tenant subscription management platform. See the
[root README](../README.md) for the one-command `docker compose up` way to run the whole stack,
and [ARCHITECTURE.md](../docs/architecture/ARCHITECTURE.md) for the full design. This file covers
only what's specific to working inside `frontend/` — the dev server, build, and tests.

## Screens

Login / signup · Dashboard (plan, seats, storage, recent users) · Resources (including the H1
cross-tenant detail view) · Users (invite, role change, revoke/remove) · Plan & usage · Audit log
· a structurally separate platform-admin shell (organisations list/detail, security events).

## Tech stack

| Layer | Technology | Version |
|---|---|---|
| Framework | React | 19.3.0 |
| Language | TypeScript | 5.9.3 |
| Build tool | Vite | 7.3.6 |
| Styling | Tailwind CSS | 4.3.3 |
| UI primitives | Radix UI (`radix-ui`) | 1.6.7 |
| Server state | TanStack Query | 5.103.1 |
| Tables | TanStack Table | 8.21.3 |
| Forms | React Hook Form | 7.88.0 |
| Validation | Zod | 4.6.5 |
| Routing | React Router | 7.18.4 |
| HTTP client | Axios | 1.20.0 |
| Toasts | Sonner | 2.0.8 |
| Icons | Lucide React | 0.475.0 |
| Testing | Vitest + React Testing Library | 3.2.7 / 16.3.3 |
| Linting | ESLint (flat config) | 9.39.3 |
| Package manager | pnpm | `>= 9` (`packageManager: pnpm@9.15.4`) |
| Runtime | Node.js | `>= 20` |

Server state (anything that comes from the API) is owned entirely by TanStack Query — no Redux,
Zustand or MobX in this codebase. Forms are React Hook Form + Zod, mirroring the backend's
class-validator DTOs so a bad input is caught before the round trip.

## Install

```bash
cd frontend
pnpm install
cp .env.example .env    # defaults work as-is against docker compose up's api-gateway
```

## Dev server

```bash
cd frontend
pnpm dev
```

Runs on <http://localhost:5178> (matches the port `docker compose up`'s `frontend` container
publishes, and `CORS_ORIGINS`' default on the gateway). Vite proxies `/api/*` to
`VITE_API_PROXY_TARGET` (`.env`, defaults to `http://localhost:3000`, api-gateway's host-published
port) so the browser talks same-origin and the gateway needs no CORS configuration for local dev.

This only talks to the API — it does not start the backend. Bring up the backend first (root
README's `docker compose up`, or at minimum `postgres`, `redis`, `kafka` and `api-gateway`) before
`pnpm dev` will show anything but failed requests.

## Building

```bash
cd frontend
pnpm build       # tsc -b && vite build — output in dist/
pnpm preview     # serve the production build locally
```

`VITE_API_BASE_URL` is a **build-time** value — Vite inlines `import.meta.env` values into the
compiled JS, so changing it after building (or at container start) has no effect. Docker's
frontend image passes it as a build arg (`docker-compose.yml`'s `build.args.VITE_API_BASE_URL`),
defaulting to api-gateway's host-published address.

## Testing

```bash
cd frontend
pnpm test          # vitest run — single pass, CI-style
pnpm test:watch    # vitest — watch mode
pnpm typecheck     # tsc -b --noEmit
pnpm lint          # eslint .
```

Run a single test file with Vitest's usual filters, e.g.:

```bash
pnpm vitest run src/pages/users/__tests__/UsersPage.test.tsx
```

## Conventions specific to the frontend

- **pnpm only** (`preinstall` script actively blocks `npm`/`yarn`).
- No Redux/Zustand/MobX — server state belongs to TanStack Query exclusively.
- Never fetch-all-and-filter for a list that can grow — every paginated list uses the server's
  keyset (cursor) pagination, matching the backend's `CursorPage<T>` shape. No page numbers, no
  total count.
- A form's Zod schema mirrors its backend DTO's class-validator rules (min lengths, formats) —
  client-side validation is a convenience for the user, never the actual control; the server
  always validates independently.
