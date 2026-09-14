# Multi-Tenant Subscription Management

A POC demonstrating **structural tenant isolation**, enforced plan limits under real concurrency,
and self-service organisation onboarding.

> **Status: architecture design complete. Implementation has not started.**
> No application code, entities, migrations or installed packages exist yet.

## The problem

A product serving several client organisations with no real wall between them: a query missing a
filter leaks one organisation's data into another's response, plan limits exist only as a number in
a spreadsheet nobody enforces, and onboarding a new client means an engineer creating rows by hand.

## The two hard cases

| # | Case | Answer |
|---|---|---|
| **H1** | A user of Org A requests, by ID, a resource belonging to Org B — with a well-formed request, from an endpoint whose author forgot to scope the query | PostgreSQL **Row-Level Security**. The filter is not in the application at all, so it cannot be forgotten. A careless `SELECT * FROM resources` returns only the caller's tenant rows |
| **H2** | Two invites arrive simultaneously; each fits the remaining seat limit, together they exceed it | One **transaction** with `SELECT … FOR UPDATE` on the subscription row, plus a `CHECK` constraint as an independent backstop. Not Redis, not Kafka |

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture/ARCHITECTURE.md) | The full technical design — 32 sections. **Start here** |
| [POC Brief](docs/architecture/POC-BRIEF.md) | The source requirements |

Sections worth reading first: **§13 Tenant Isolation** and **§19 Concurrency** — the rest of the
architecture is subordinate to those two.

## Planned stack

**Backend** — NestJS microservices · TypeScript · **TypeORM** (the only permitted ORM) ·
PostgreSQL · Kafka (KRaft) · Redis · JWT + Passport + Argon2 · CASL · **pnpm**

**Frontend** — React · TypeScript · Vite · Tailwind · TanStack Query + Table · React Hook Form +
Zod · Vitest + RTL · **pnpm**

Seven services: `api-gateway`, `auth-service`, `tenant-service`, `user-service`,
`subscription-service`, `resource-service`, `audit-service`. Each owns its data; §7 explains why
each exists and §14 who owns what.

## Repository layout

```
backend/     NestJS monorepo — pnpm workspace   (not yet scaffolded)
frontend/    React SPA                          (Vite scaffold only)
docs/        architecture + brief
.claude/     skills and agents governing implementation
```

## Getting started

Nothing to run yet. Once implementation begins:

```bash
cp .env.example .env
docker compose up
```

No manual setup beyond the documented `.env` — that is a requirement of the POC, not an aspiration.

## Conventions

Implementation is governed by the skills in [.claude/skills/](.claude/skills/). The rules that
matter most:

- **TypeORM only.** Never Prisma, Sequelize, Drizzle or Mongoose.
- **pnpm only.** Never `npm install` or `yarn add`.
- Every tenant table enables **and forces** RLS in the migration that creates it.
- Limit checks are one Postgres transaction with a row lock — never Redis, never Kafka.
- Tenant isolation is never enforced by a CASL rule or a hand-written `WHERE` clause.
