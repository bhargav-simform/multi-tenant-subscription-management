# POC: Multi-Tenant Subscription Management

**Track:** Platform · **Status:** Required · **Path:** React to Full Stack — 101 (2-week solo POC)
**Stack:** Express or Next.js (engineer's choice) · PostgreSQL · Prisma

## 1. Background

A product serving several client organisations has no real wall between them: a query missing
a filter can leak one organisation's data into another's response, plan limits exist only as a
number in a spreadsheet nobody enforces, and onboarding a new client means someone on the
engineering team manually creating rows.

You're building the system that fixes this: every organisation's users and data are isolated
from every other's as a property of the architecture, plans define hard limits that are
actually enforced, and a new organisation can onboard itself without a ticket.

This POC's centre of gravity is **structural tenant isolation** — isolation that holds because
of how the system is built, not because every engineer remembered to add a `WHERE tenant_id =`
clause to every query they wrote.

## 2. Actors

| Role | Can do |
|---|---|
| **Org admin** | Manage their own organisation's users and roles, view their own organisation's usage against plan limits |
| **Org member** | Use the product within their organisation; see only their own organisation's data |
| **Platform admin** | View organisations and their plan/usage metadata; cannot view organisation content |

## 3. Functional requirements

### 3.1 Organisations and users
- Each organisation (tenant) has its own users and its own data. A user belongs to exactly one
  organisation.
- **A user of one organisation must never be able to see another organisation's data, under any
  request — including a well-formed request for a resource by ID that happens to belong to a
  different organisation.** This is the core hard case of this POC.

### 3.2 Self-service onboarding
- A new organisation can be created without engineering involvement: a signup flow creates the
  organisation, its first admin user, and whatever default records a fresh organisation needs
  (e.g. a default plan assignment).
- Decide and document what happens if onboarding fails partway through (e.g. the organisation
  is created but the admin user creation fails) — a half-created organisation should not be
  left in a state that blocks a retry or leaves orphaned data.

### 3.3 Plans and limits
- Plans define limits such as maximum user count and maximum storage (or another resource you
  choose) per organisation.
- An action that would exceed a plan's limit (e.g. inviting a user past the seat cap) is refused
  with a clear, specific message — not a generic error, and not a silent partial success.
- **Two simultaneous requests that would each individually fit within the remaining limit, but
  together exceed it, must not both succeed.** Decide how you guarantee that under real
  concurrency.

### 3.4 Organisation administration
- Org admins manage their own organisation's users: inviting, removing, and assigning roles.
- An org admin can only ever affect users within their own organisation, including if they try
  to reach a user in another organisation directly by ID.

### 3.5 Platform admin visibility
- A platform admin can view the list of organisations, their plan, and aggregate usage — but
  cannot view any organisation's actual content/data.
- This boundary needs to be real: a platform admin route or query that happens to expose content
  data is a failure of this POC even if nothing in the UI links to it.

### 3.6 Tenant context enforcement
- Decide where tenant scoping is applied: at the point of every individual query, or through a
  single enforced mechanism (e.g. a request-scoped tenant context that every data-access path is
  forced through). Whichever you choose, be ready to show what happens when a new feature is
  added by someone who forgets to add tenant scoping by hand.

## 4. Data to think through

You choose the exact schema. At minimum, your model needs to represent: organisations, the plan
each is on and its defined limits, users scoped to exactly one organisation each, and the
resource(s) whose count or size counts against a plan's limit.

The question worth sitting with before you write any code: is tenant isolation something every
individual query has to remember to apply, or something structural that a query cannot bypass
even if the engineer writing it forgets? Be ready to show what a new, badly-written query looks
like under your design — does it leak data across tenants, or is that structurally impossible?

## 5. How it's exposed

Design the API surface — routes, methods, request/response shapes — however fits the workflow
above. There's no prescribed structure here; the requirements in §3 are the spec, not a
particular set of endpoints.

## 6. Things this POC will specifically be checked for

- Bad input — an invite to a malformed email, a plan that doesn't exist — should be rejected
  before it reaches your business logic.
- There's no anonymous path through this system beyond the onboarding/signup flow itself; every
  other action is tied to a real, authenticated user scoped to a real organisation.
- **This is the sharpest test in this POC:** a test proving one organisation's user cannot read,
  by ID, a resource belonging to another organisation — and a second test or code-level argument
  for what happens if a developer forgets the tenant filter on a brand-new query.
- The plan-limit guarantee (§3.3) needs to hold under real concurrency. Have a test that fires
  two simultaneous requests that would each fit individually but together exceed the limit, and
  assert only one succeeds.
- The organisation list (for platform admins) and any per-organisation resource list need to
  stay usable as organisations and their data grow — neither should mean loading everything into
  memory and filtering in code.
- Onboarding, plan-limit rejections, and any cross-tenant access attempt should leave a
  structured trace — this is what you'd use to detect a tenant leak in production, not just
  explain one after the fact.
- The whole thing should come up with `docker compose up` and no manual setup beyond a
  documented `.env`.

## 7. Walkthrough questions to expect

NOTE: These are indicative questions only. Expect to be asked further questions in a similar
spirit during the walkthrough.

1. Show me the test that proves one organisation cannot read another's data. Now show me what
   happens if a developer forgets the tenant filter on a new query.
2. Where does tenant context come from, and where is it applied — every service method, or one
   place?
3. A platform admin can see organisations but not content. Prove it.

## 8. If you finish early (optional)

Don't add new features — deepen what's here:
- Add a deliberately careless new query (e.g. a report endpoint written without going through
  your tenant-scoping mechanism) and show your architecture either makes it structurally
  impossible to leak data, or makes the leak immediately obvious in a test.
- Load-test plan-limit enforcement with a simulated burst of 50 concurrent invite requests
  against an organisation two seats away from its cap, and show exactly the right number
  succeed.
- Build a small internal tool or query that could detect a tenant leak in production (e.g. a
  scan for resources whose foreign keys resolve to a different organisation than their owner)
  and demonstrate it against a deliberately broken seed case.
