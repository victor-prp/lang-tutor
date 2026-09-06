# ADR 0003: OpenAPI generated from the wire contract

- **Status:** Accepted
- **Date:** 2026-09-06
- **Source:** [phase 7 design](../superpowers/specs/2026-09-05-lang-tutor-phase-7-openapi-design.md)

## Decision

Every REST endpoint is declared once, as a `createRoute` definition backed by a Zod schema
in `packages/core`, and that single declaration serves as routing, request validation,
response typing and OpenAPI generation at once. Documentation cannot drift from the code
because there is no second document to keep in step.

```
packages/core/src/api/
  schemas.ts   plain Zod 4 — the wire contract, source of truth
  types.ts     every type: z.infer<typeof XSchema>, none hand-written
  index.ts     export type only — mobile never pulls in Zod

apps/server/src/
  routes/*.ts  createRoute(schema) + router.openapi(route, handler)
  app.ts       OpenAPIHono, mounts /openapi.json and /docs
```

`packages/core` depends on plain Zod only — no Hono adapter — so `./api` stays safe for
`apps/mobile` to import as types. OpenAPI metadata is attached server-side, in
`createRoute`.

## Rules

| # | Subject | May do | Must not do |
|---|---|---|---|
| R1 | `apps/server/src/routes/`, `app.ts` | Declare an endpoint via `createRoute` + `router.openapi(...)` / `app.openapi(...)` | Register an API endpoint with a raw Hono verb (`.get(`, `.post(`, `.put(`, `.patch(`, `.delete(`) — the `/docs` UI mount is the sole exception, since it is not part of the published API |
| R2 | `apps/server/src/routes/` | Import request/response schemas from `@lang-tutor/core/api/schemas` | Define its own schema file (`schemas.ts` or similar) — the wire contract has exactly one home |
| R3 | `packages/core/src/api/types.ts` | Export `z.infer<typeof XSchema>` | Export a hand-written type |
| R4 | `packages/core/src/api/index.ts` | `export type { ... }` | Export a value (a schema, a runtime helper) |
| R5 | `packages/core/src` | Depend on plain `zod` | Import `hono` or any `@hono/*` package |
| R6 | `apps/server/src/app.ts` | Mount `/openapi.json` and `/docs` | Use `/doc` (singular) anywhere — one character apart from `/docs` is a permanent footgun |

## Rules that are not import rules

- **R7 — The validation-failure body stays `{ error: 'invalid request' }`.** Each
  `OpenAPIHono` that validates a request body supplies a `defaultHook` restoring that
  shape; the adapter's own 400 would otherwise carry a Zod issue payload instead, and
  nothing in the repo would notice — the route tests asserted `res.status` only and the
  mobile client discards the body. Not greppable: the defaultHook is one line among many
  legitimate `new OpenAPIHono(...)` calls (`/health` takes no body and needs none),
  so no import pattern distinguishes "should have one" from "doesn't need one."
  Enforced by `apps/server/src/openapi.test.ts`'s *"declares the error body it actually
  returns"* assertions and by the route tests' 400-body checks.
- **R8 — Every exported type in `packages/core/src/api/types.ts` is inferred, not
  reasoned about structurally.** `tsc` cannot tell a hand-written type that happens to
  match a schema's shape from a genuine `z.infer`; R3's grep catches the textual form
  (`export type X = ...`), but a type alias that merely re-exports an equivalent shape
  under a different name would not trip it. Spot-checked in review against the list in
  `## Rules` above.

## How to detect a violation

`npm run lint:arch` runs the six commands below alongside ADR 0001's and ADR 0002's;
`scripts/check-adr-0003-openapi-wire-contract.sh` mirrors this block verbatim. Each
command must print nothing.

```bash
# R1 — every route uses createRoute + .openapi(), not a raw Hono verb
grep -rnE "\.(get|post|put|patch|delete)\(" apps/server/src/routes/ apps/server/src/app.ts \
  | grep -v "app.get('/docs'"

# R2 — no route-local schema file; the wire contract lives in packages/core only
find apps/server/src/routes -iname 'schemas.ts'

# R3 — every type in core/api/types.ts is a z.infer
grep -nE "^export type" packages/core/src/api/types.ts | grep -v "z\.infer"

# R4 — core/api/index.ts exports types only
grep -n "^export " packages/core/src/api/index.ts | grep -v "export type"

# R5 — packages/core has no Hono dependency
grep -rln "@hono\|from 'hono'" packages/core/src

# R6 — doc routes are /openapi.json and /docs, never the /doc typo
grep -n "'/doc'" apps/server/src/app.ts
```

### What the rules cover

- Scans `apps/server/src/routes/`, `apps/server/src/app.ts` and all of `packages/core/src`
  — the whole surface phase 7 touched.
- `apps/mobile` is deliberately unscanned: phase 7 states no mobile change as a success
  criterion, and it imports only types from `@lang-tutor/core/api`, never `./api/schemas`.
- No composition-root exclusions apply — `createRoute` definitions and their handlers are
  ordinary route-layer code, not I/O construction, so ADR 0002's composition-root carve-out
  is irrelevant here.

## Why

- R1 exists because `router.openapi(route, handler)` is what makes `route` and `handler`
  one artifact; a raw `.post(...)` beside it would run without ever being validated
  against, or published from, its own schema — silently un-documented, not merely
  inconsistent style.
- R5 is stricter than "core happens not to import Hono today": `packages/core` must stay
  importable by `apps/mobile`, and a Hono dependency there would drag transport code into
  a React Native bundle that never makes an HTTP request through Hono.
- R6 is recorded because the cost of the typo is not a lint failure, it is two live routes
  a request can silently hit the wrong one of — worth naming as a rule precisely because
  nothing about `/doc` vs `/docs` looks dangerous until it is.

## Related

- [ADR 0001](adr-0001-layered-architecture.md) R1/R5 — `routes/` and `app.ts` may import
  `@lang-tutor/core/api*`, `@hono/zod-openapi` and `@scalar/hono-api-reference`; this ADR
  governs what those imports must look like once made, not whether they are allowed.
- [ADR 0002](adr-0002-di-with-closures.md) — orthogonal axis: this ADR does not change how
  `AppDeps` is constructed or passed.
