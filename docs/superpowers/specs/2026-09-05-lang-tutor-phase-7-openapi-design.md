# Phase 7: OpenAPI documentation generated from the wire contract

Implements decision 3 of
[`docs/superpowers/phase-4-pr-review.md`](../phase-4-pr-review.md): a machine-readable
API description that cannot drift from the code, because the route definition and the
documentation are the same artifact.

Nothing here changes what the API does. The HTTP contract is preserved exactly — this
phase changes how routes are *declared* and adds documentation surface.

## Goals

- One definition per endpoint that serves as routing, request validation, response
  typing and OpenAPI generation at once — so documentation cannot fall out of date
  without the code failing.
- One home for the wire contract, shared by server and mobile, instead of Zod schemas
  on one side and hand-written types on the other.
- An interactive page for reading and exercising the API without asking anyone to
  generate a description of it.
- Error responses become part of the published contract rather than implicit in
  handler code.

## Non-goals

- **Changing the HTTP contract.** Same paths, same status codes, same bodies — including
  the `{ error: 'invalid request' }` validation body, which this phase takes deliberate
  steps to preserve (see *The validation body*).
- **Richer validation errors.** Worth considering, but it is a contract change and
  belongs to its own decision, not to a side effect of adopting a documentation tool.
- **Any change to `apps/mobile`.** A success criterion, not merely an expectation.
- **Generating a client from the spec.** The mobile client stays hand-written.

## Precondition: phases 5 and 6 first

Phase 5 reshapes `createApp` and how the router is constructed; phase 6 relocates the
route tests. This phase rewrites both again. Running it earlier means three phases
touching the same files in sequence and the route tests moving twice.

## Dependency landscape

Verified against the registry rather than assumed, because this project has been caught
three times by toolchain assumptions (drizzle's `.cause`, Playwright's setup ordering,
a missing `ts-node`):

| Package | Requires | This repo has | |
|---|---|---|---|
| `@hono/zod-openapi@1.6.3` | `zod ^4.0.0`, `hono >=4.10.0` | zod **4.4.3**, hono **4.13.5** | fits unmodified |
| `@scalar/hono-api-reference@0.12.0` | `hono ^4.12.5` | hono **4.13.5** | fits unmodified |

Note that `apps/server` resolves a *nested* Zod 4.4.3; the repo root hoists a 3.25.76
copy belonging to another dependency. The server's resolution is what matters, and it
is Zod 4 — which is why the adapter's v1 line applies rather than its 0.x line.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where schemas live | `packages/core`, behind a new `./api/schemas` entry point | One definition shared by both sides. The separate entry keeps `./api` purely type-only, so a mobile import that forgets the `type` keyword fails loudly instead of quietly pulling Zod into the app bundle. |
| Types | Inferred: `export type X = z.infer<typeof XSchema>` | The alternative — schemas server-side, hand-written types in core — is two definitions of one contract, free to drift. That is the problem this phase exists to remove. |
| Which `z` core uses | Plain Zod 4, not the adapter's extended `z` | Core must not depend on a Hono adapter. OpenAPI metadata is attached server-side in `createRoute`. |
| Validation failures | A `defaultHook` restoring `{ error: 'invalid request' }` | The adapter's built-in 400 carries a Zod issue payload instead. Nothing in the repo would notice the change — tests assert status only and the mobile client discards the body — which is precisely why it must be deliberate. |
| Documentation UI | Scalar (`@scalar/hono-api-reference`) | Chosen over `@hono/swagger-ui`. Both are compatible; this is a preference for the better reading and request-building experience. |
| Doc routes | `/openapi.json` and `/docs` | Not `/doc` + `/docs`: one character apart is a permanent footgun. |
| Exposure | Always on, not gated | No auth, no secrets, and the surface is already fully described by an open-source client that calls it. Gating adds configuration and removes no risk. |

## Architecture

### Where the contract lives

```
packages/core/src/api/
  schemas.ts   Zod 4 schemas — the source of truth              [new]
  types.ts     every type inferred: `export type X = z.infer<typeof XSchema>`
  index.ts     unchanged — still `export type { … }` and nothing else
```

with a new entry point in `packages/core/package.json`:

```json
"exports": {
  ".": "./src/index.ts",
  "./api": "./src/api/index.ts",
  "./api/schemas": "./src/api/schemas.ts",
  "./domain": "./src/domain/index.ts"
}
```

All six existing mobile imports keep working untouched — every one of them is
`import type` from `./api`, and the only value import from core anywhere in the mobile
app is `SESSION_LENGTH` from the separate `./domain` entry.

`packages/core` gains its first dependency, `zod`. That is the real cost of this
choice, accepted because the alternative is two definitions of one contract.

**`apps/server/src/routes/schemas.ts` is deleted.** Its two request schemas belong to
the same wire contract as the responses and move into `core/api/schemas.ts` — request
and response defined together, which is the premise of the whole phase.

### The routes

Each endpoint becomes a single `createRoute` definition plus its handler:

```ts
const createSession = createRoute({
  method: 'post',
  path: '/',
  request: { body: { content: { 'application/json': { schema: CreateSessionRequestSchema } } } },
  responses: {
    200: { content: { 'application/json': { schema: CreateSessionResponseSchema } }, description: '…' },
    400: { content: { 'application/json': { schema: ErrorSchema } }, description: '…' },
  },
});

router.openapi(createSession, (c) => {
  const body = c.req.valid('json');
  …
});
```

`createApp` constructs an `OpenAPIHono` rather than a `Hono` and mounts the two
documentation routes; `createSessionsRouter` likewise returns an `OpenAPIHono`. Phase
5's `createApp(deps)` shape is otherwise unaffected.

Use `doc31` if the adapter offers it: Zod 4 emits JSON Schema 2020-12, which
corresponds to OpenAPI 3.1 rather than 3.0. Confirm on the first route.

### The validation body

`@hono/zod-openapi` validates the request against the schema automatically, and on
failure returns *its own* 400 carrying a Zod issue payload — not the current
`{ error: 'invalid request' }`.

Nothing in this repository would catch that change. The route tests assert
`res.status` only, and `apps/mobile/src/api/client.ts` does
`throw new ApiError(res.status)`, discarding the body entirely. An undetectable
contract change is the kind that surprises someone months later, so a `defaultHook`
restores the current body, and the 400 response schema declares exactly that shape so
the published document matches what is actually returned.

### Error responses become explicit

Today the `{ error: string }` shape exists only inside handler code. Each route now
declares its failures — `next-step` declares 200, 400, 404 and 409 against a shared
`ErrorSchema = z.object({ error: z.string() })`. This is real work rather than
transcription, and it is what makes the published description honest instead of a
happy-path sketch.

### Documentation endpoints

Mounted in `createApp`, always on:

- `GET /openapi.json` — the generated document
- `GET /docs` — Scalar, pointed at it

## Testing

The load-bearing assertion is that **every existing route test passes unmodified**.
That is the proof a structural rewrite preserved the contract; if a test needs editing
to pass, the contract moved and the change needs justifying.

Three additions:

- **`/openapi.json` contains all three paths** with their declared responses — the
  "documentation cannot drift" proof. After phase 5, `createApp` accepts fakes, so this
  test needs no database and belongs in phase 6's **unit** bucket.
- **The 400 body is still `{ error: 'invalid request' }`.** Added precisely because
  nothing asserts it today, which leaves the `defaultHook` as the only thing between
  this phase and a silent contract change.
- **Type parity rides on the existing typecheck** rather than new machinery: mobile and
  server both compile against the inferred types across all four workspaces, so an
  inferred type that drifts from what mobile expects fails `npm run typecheck`.

## Success criteria

- `GET /openapi.json` returns a valid OpenAPI document containing all three paths with
  their 200/400/404/409 responses; `GET /docs` renders Scalar against it
- Every pre-existing route test passes **unmodified**
- `packages/core/src/api/index.ts` still contains only `export type` — the type-only
  barrel invariant holds
- `apps/server/src/routes/schemas.ts` no longer exists
- Every type in `packages/core/src/api/types.ts` is a `z.infer`; none hand-written
- **`git diff --stat apps/mobile` is empty** — this phase requires no mobile change
- `npm run typecheck`, `npm run test:all` and `npm run e2e` all green

## Risks

**Plain Zod in core converting to OpenAPI is unverified.** Core uses plain Zod 4, not
the adapter's extended `z`. Zod 4's native JSON-Schema support is the reason the
adapter's v1 line supports Zod 4 at all, so this should hold — but it has not been
executed. Mitigation is sequencing: convert **one** route and confirm `/openapi.json`
renders before touching the other two. If it fails, the fallback is thin server-side
`.openapi()` wrappers around core's schemas — not making `packages/core` depend on a
Hono adapter.

**`NextStepResponse` is the schema most likely to bite.** It is a discriminated union
on `complete`, and the mobile app relies on that narrowing to know whether `score` and
`missed_questions` are present. A Zod `discriminatedUnion` inferring to a subtly
different type — optional where the hand-written version was required, or a widened
literal — is the realistic failure. Typecheck is the guard; port this schema first
among the responses so the hardest case is proven early.

**The error contract rests entirely on the `defaultHook`.** Misconfigure it and the 400
body changes with nothing to notice. That is why the body assertion is in scope rather
than optional.

**Two more runtime dependencies** on a server that deliberately runs four. Also worth
confirming during implementation: Scalar typically loads its client bundle from a CDN,
so the documentation page may require network access. A docs page that does not work
offline undercuts "documentation I can review locally", and is better discovered now
than by someone on a plane.

**Always-on documentation publishes the API surface.** Accepted above for a no-auth
application whose client is open source, and recorded here so it reads as a decision
rather than an oversight.
