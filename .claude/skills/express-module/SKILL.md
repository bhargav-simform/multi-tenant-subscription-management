---
name: express-module
description: >
  Build or extend a backend feature in the Express + Prisma MVC monolith following the
  approved layering. Use when: adding an endpoint, creating a new module/area, writing
  a route, controller, service, model, view or DTO, adding middleware, or when the
  user says "add endpoint", "new module", "create service", "new route", "wire this
  up", "vertical slice".
---

# Express Module Conventions

Reference: `docs/architecture/ARCHITECTURE.md` §0.2, §21.2, §21.3; `backend/README.md`.

## The slice

One feature touches these files, in `backend/src/`:

| Layer | File | Does | Never |
|---|---|---|---|
| DTO | `dtos/<area>.dto.ts` | class-validator classes for body/query | Include `organizationId` or `createdBy` — they come from the token |
| Model | `models/<table>.model.ts` | Prisma / tagged raw SQL; takes `Tx`; `BigInt → number` | Read `contextStore`/`req`, open a transaction |
| Service | `services/<area>.service.ts` | Business rules, transaction boundary, limit checks, `publish()` after commit | Touch `req`/`res`, call `getPrisma()` for tenant data |
| View | `views/<area>.view.ts` | Domain object → response body | Leak `organizationId` or internal columns |
| Controller | `controllers/<area>.controller.ts` | Read `req.body` / `req.validatedQuery` / `req.params`, call the service, render the view, set the status | Business rules, transactions, models, Prisma |
| Route | `routes/<area>.routes.ts` | Path + middleware chain; export `<area>Routes(): Router` | Logic |

Register a new router in `routes/index.ts`. Schema changes go through the
`prisma-schema` skill first.

## Middleware order (per route)

```ts
router.post(
  '/projects',
  throttle,                                   // always first (except health)
  authenticate,                               // or `anonymous` for a justified public route
  requirePlatformAdmin,                       // only on platform-admin-only routes
  authorize(Action.CREATE, Subject.PROJECT),  // CASL, subject-type level
  validateBody(CreateProjectDto),             // or validateQuery(...) → req.validatedQuery
  projects.create,
);
```

- `parseUuidParam('id')` after `authorize` when an `:id` must be a UUID (400
  `Validation failed (uuid is expected)`).
- A new public route (`anonymous`) needs an explicit justification in ARCHITECTURE.md
  §11.5 — there are exactly four today. A new unauthenticated *write* route belongs in
  `STRICT_THROTTLE_PATHS` (`middlewares/throttle.ts`).
- App-level order (`app.ts`) is fixed: helmet → CORS allowlist → `express.json` →
  correlation id → pino-http → `/api/v1` → `errorHandler`. Don't add global middleware
  without an architecture review.

## Controllers

```ts
export async function create(req: Request, res: Response): Promise<void> {
  const project = await projectsService.create(req.body as CreateProjectDto);
  res.status(201).json(toProjectResponse(project));
}
```

Async handlers just throw — Express 5 forwards rejections to `errorHandler`. No
`try/catch` to build error responses.

## Services

```ts
export async function create(input: CreateProjectInput): Promise<Project> {
  const ctx = contextStore.getOrThrow();                 // identity from ALS, never req
  const organizationId = ctx.organizationId as string;

  const project = await transaction(async (tx) => {      // lib/tenant-db.ts — RLS-scoped
    // limit checks: see the concurrency-safety skill (lock FIRST)
    return projects.create(tx, { organizationId, ...input, createdBy: ctx.userId as string });
  });

  await publish(TOPICS.PROJECT, { /* ... */ });           // AFTER commit — domain-events skill
  return project;
}
```

- Pick the tenant-db helper deliberately: `transaction` (request), `transactionForOrganization`
  (handler/job with an explicit org), `transactionWithDeferredScope` (org discovered
  mid-transaction), `runGlobal` (registry/global tables only — logged).
- Cross-module calls are **direct function calls** to the other module's service.
  There is no internal HTTP, no gateway, no signed context.
- Row-level authorization (e.g. "members may only delete their own") is checked here,
  on the loaded row, after the RLS-scoped read; not-found stays 404 (never 403 for a
  foreign-tenant id).

## Errors

Throw from `lib/http-errors.ts` — bodies are a frozen contract with the frontend:

| Throw | Body |
|---|---|
| `new NotFoundException()` | `{ message: 'Not Found', statusCode: 404 }` |
| `new ConflictException('msg')` | `{ message: 'msg', error: 'Conflict', statusCode: 409 }` |
| `new PlanLimitExceededException(details, message)` | `{ statusCode: 409, error: 'PLAN_LIMIT_EXCEEDED', message, details }` |
| `LastAdminException`, `ForbiddenException`, `GoneException`, `ServiceUnavailableException`, … | Nest-compatible shapes |
| anything else | `{ statusCode: 500, message: 'Internal server error' }` — detail only in logs |

Never return `res.status(4xx).json(...)` by hand; never put internal detail in a message.

## Tests

- Unit (`backend/tests/unit/<area>.service.spec.ts`): `jest.mock` the models,
  `lib/events` and `lib/prisma`; run under `contextStore.run(ctx, ...)`.
- Integration / HTTP (`tests/integration`, `tests/http`): real Postgres via
  `PostgresTestContainer`, drive `createApp()` with Supertest. See the `testing` skill.

## Checklist

- [ ] DTO has no tenant/actor ids; `validateBody`/`validateQuery` on the route
- [ ] Route chain order: throttle → authenticate|anonymous → [requirePlatformAdmin] → authorize → validate
- [ ] Router registered in `routes/index.ts`
- [ ] Controller has no logic; view shapes the response
- [ ] Service uses a `lib/tenant-db.ts` helper; no Prisma outside models
- [ ] Events published after commit
- [ ] Errors via `lib/http-errors.ts`
- [ ] New CASL subject added to `types/constants.ts` and `lib/casl.ts` for all three roles
- [ ] Unit tests + an RLS/HTTP test where tenant data is involved; `architecture-review` run
