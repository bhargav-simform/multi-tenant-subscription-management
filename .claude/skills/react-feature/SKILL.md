---
name: react-feature
description: >
  Build or modify a frontend feature. Use when: adding a page or component, wiring
  an API call, building a form or table, adding a route, or when the user says
  "add page", "new feature", "build UI", "add form", "add table", "frontend".
  No Redux/Zustand/MobX — server state belongs to TanStack Query.
---

# React Feature Development

Reference: `docs/architecture/ARCHITECTURE.md` §23, §24.

## Stack

React · TypeScript · Vite · **pnpm** · Tailwind · TanStack Query · TanStack Table ·
React Router · Axios · React Hook Form · Zod · lucide-react · clsx + tailwind-merge ·
Vitest + RTL.

**No Redux, Zustand or MobX.** Server state is the only real state and TanStack Query
owns it. Adding a store creates synchronisation bugs that do not otherwise exist.

## Structure

```
src/features/<feature>/
├── components/      feature-specific components
├── hooks/           useX queries and mutations
├── api/             axios calls
├── schemas/         Zod schemas (mirror backend DTOs)
└── types.ts
```

A feature may import from `components/ui`, `lib`, `services`, `hooks`.
**A feature never imports from another feature.** Shared code moves up.

## Data fetching

```ts
export function useUsers(cursor?: string) {
  return useQuery({
    queryKey: queryKeys.users.list(cursor),
    queryFn: () => usersApi.list(cursor),
    placeholderData: keepPreviousData,
  });
}
```

- Query keys centralised in `services/queryKeys.ts`.
- **Keys are tenant-agnostic** — the tenant is implicit in the token, so `orgId`
  never appears in a key.
- Mutations invalidate the affected keys on success.
- Lists use **keyset cursors**, matching the server (§29). Never fetch-all-and-filter.

## Error handling

Surface the server's structured error. In particular, show the `PLAN_LIMIT_EXCEEDED`
message **verbatim**:

```ts
onError: (err) => {
  const e = err.response?.data;
  if (e?.error === 'PLAN_LIMIT_EXCEEDED') {
    toast.error(e.message);   // the backend wrote a clear, specific message
    return;
  }
  toast.error('Something went wrong');
}
```

Replacing that message with a generic one defeats requirement R6, which the backend
went to some trouble to satisfy.

## Auth

- Access token in **memory** (`AuthProvider` state) — never `localStorage` (XSS).
- Refresh token is an httpOnly cookie.
- Axios response interceptor refreshes once on 401 and retries; concurrent 401s share
  one in-flight refresh promise.
- Silent refresh on mount restores a session across reloads.

## Routing and roles

```
<PublicRoute>     /login  /signup
<ProtectedRoute>  valid session required
<RoleRoute>       role required
```

Platform-admin routes live under a **separate layout with no content-feature imports
at all**, mirroring the backend's structural separation (§13.6) so a content component
cannot be mounted on an admin page by accident.

**The UI never enforces security.** Hiding a button is UX; the server decides.

## Forms

React Hook Form + Zod. Schemas mirror backend DTOs so bad input is caught before a
round trip — but the server validates independently, always. The client schema is a
convenience, never the control.

## Components

- Primitives in `components/ui` (§24.2): variants via a small map, `cn()` from
  clsx + tailwind-merge, `forwardRef`, native prop passthrough.
- Semantic colour tokens (`danger`, not `red-600`).
- Tables: TanStack Table headless + the `Table` primitive, **server-side** pagination,
  sorting and filtering.

## Accessibility

Semantic HTML · labelled inputs · visible focus rings · dialogs trap and restore focus
and close on Escape · errors via `aria-live` · colour never the only signal.

## Checklist

- [ ] Feature-scoped; no cross-feature imports
- [ ] Server state via TanStack Query; no client store added
- [ ] Query keys centralised and tenant-agnostic
- [ ] Server error messages surfaced verbatim where specific
- [ ] Lists paginate server-side with keyset cursors
- [ ] Forms use RHF + Zod mirroring backend DTOs
- [ ] Role-gated routes; admin routes import no content features
- [ ] Accessible: labels, focus, keyboard, `aria-live`
- [ ] Vitest + RTL tests covering behaviour
