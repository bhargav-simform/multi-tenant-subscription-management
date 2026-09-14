---
name: nest-service
description: >
  Build or extend a NestJS service in the backend monorepo following the approved
  layering and DI conventions. Use when: adding an endpoint, creating a module,
  wiring providers, adding a guard/interceptor/filter, or when the user says
  "add endpoint", "new module", "create service", "wire this up", "vertical slice".
---

# NestJS Service Conventions

Reference: `docs/architecture/ARCHITECTURE.md` §20, §21.2.

## Layering

```
Controller            HTTP only. Route, DTO in, DTO out. No business rules
    ↓ injects
Application Service   Orchestration, transaction boundaries, event collection
    ↓ injects
Domain                Pure rules. No framework imports, no I/O
    ↓ injects INTERFACE
Repository Interface  Declared by the domain
    ▲ implements
TypeORM Repository    Infrastructure. Extends TenantRepository
```

Dependency direction is the point: the domain declares what it needs; infrastructure
implements it. The domain never imports TypeORM.

## Service internal structure

```
apps/<service>/src/
├── main.ts
├── app.module.ts
├── <feature>/
│   ├── <feature>.controller.ts     HTTP only
│   ├── <feature>.service.ts        orchestration + transactions
│   ├── domain/                     pure rules + repository INTERFACES
│   ├── infrastructure/             TypeORM repository implementations
│   ├── entities/                   owned entities (extend TenantBaseEntity)
│   └── dto/                        class-validator DTOs
├── database/migrations/
└── events/                         producers + consumers
```

## Dependency injection

**Never `new SomeService()`.** Bind interfaces by token:

```ts
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  countByOrganization(): Promise<number>;
}

// module
providers: [
  { provide: USER_REPOSITORY, useClass: TypeOrmUserRepository },
]

// consumer
constructor(@Inject(USER_REPOSITORY) private readonly users: IUserRepository) {}
```

Use an interface where an alternative implementation is plausible: repositories,
event publisher, cache, clock. **Not** for everything — a mapper behind an interface
is ceremony. Default scope is singleton; tenant context comes from `AsyncLocalStorage`,
not request-scoped providers (§20.4).

## Guard order

```
InternalContextGuard → TenantContextMiddleware(ALS) → ValidationPipe → CaslAbilityGuard → handler
```

Registered as global `APP_GUARD`s, so routes are protected by default. Only
`api-gateway` has `@Public()` routes, and exactly two of them.

## Controllers

```ts
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post('invite')
  @CheckAbility(Action.Create, Subject.User)
  invite(@Body() dto: InviteUserDto): Promise<UserResponseDto> {
    return this.users.invite(dto);   // no logic here
  }
}
```

Never in a controller: business rules, transactions, direct repository access,
reading tenant context from `req`.

## Application services

Own the transaction boundary. Explicit, never a hidden decorator:

```ts
async invite(dto: InviteUserDto): Promise<UserResponseDto> {
  const events: DomainEvent[] = [];
  const result = await this.dataSource.transaction(async (manager) => {
    // ... see the concurrency-safety skill for limit checks
  });
  await this.publisher.publishAll(events);   // AFTER commit
  return result;
}
```

## New service checklist

- [ ] Registered in `nest-cli.json` and `pnpm-workspace.yaml`
- [ ] Own `Dockerfile`, health endpoints (`/health`, `/health/ready`)
- [ ] Env validated at boot with a schema; startup asserts DB role is `NOBYPASSRLS`
- [ ] Global guards, `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`), exception filter
- [ ] Own `DataSource` and migrations directory
- [ ] Internal-network only in compose — no published port unless it is the gateway
