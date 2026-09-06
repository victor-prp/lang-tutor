# ADR 0001: Layered architecture in `apps/server`

- **Status:** Accepted
- **Date:** 2026-08-30 (phase 4); rules updated to match the tree as of 2026-09-06
- **Source:** [phase 4 design](../superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md)

## Decision

`apps/server/src` is layered, with a strict **inward** dependency rule: a layer may
depend on layers below it and on shared leaf modules, never on layers above it.

```
  index.ts          process        config, pool, serve, SIGTERM
  composition.ts    wiring         createServerDeps(io) -> AppDeps
  app.ts            wiring         createApp(deps) — mounts routes, no logic
        │
        ▼
  routes/           transport      Hono. Parse, validate, map outcome -> status code
        │
        ▼
  services/         application    use cases. Owns the transaction boundary
        │
        ├──────────────────────┐
        ▼                      ▼
  domain/           domain      repo/ + db/    persistence
  packages/core                                Drizzle, SQL
  pure functions, no I/O
```

`errors.ts` and `logger.ts` are leaf modules: any layer may import them, they import
nothing from the server.

`packages/core/domain` and `apps/server/src/domain` are one layer split by audience —
core holds rules either side of the wire may need (`pickQuestions`, `evaluate`, `score`),
the server's holds the session state machine only a server has (`step`, `SessionRecord`).

## Rules

| # | Layer | May import | Must not import |
|---|---|---|---|
| R1 | `routes/` | `services/` (types only), `domain/`, `errors`, `@lang-tutor/core/api*`, Hono, zod | `db/`, `repo/`, `drizzle-orm`, `pg` |
| R2 | `services/` | `domain/`, `repo/` (**types only**), `db/client` (the `Db`/`Tx` handle), `errors`, `logger` | Hono, `hono/*`, `@hono/*`, HTTP status codes, `db/schema`, `drizzle-orm`, `pg` |
| R3 | `domain/` | `@lang-tutor/core/*` only | anything else in `apps/server/src`, `pg`, `drizzle-orm`, Hono, `Date.now`, `Math.random` |
| R4 | `repo/` + `db/` | `drizzle-orm`, `pg`, `db/*`, domain **types** | `routes/`, `services/`, `app.ts`, `composition.ts` |
| R5 | `app.ts` | `composition` (type `AppDeps`), `routes/`, Hono | `db/`, `repo/`, `services/`, `drizzle-orm`, `pg` |
| R6 | `composition.ts` | every factory it wires | nothing that performs I/O at call time (no `createDb`, no `new Pool`) |
| R7 | anywhere | — | `console` outside `logger.ts` and `index.ts`/`db/cli.ts` |

Two rules that are not import rules:

- **R8 — Transactions belong to `services/`.** `db.transaction(...)` appears only in
  `apps/server/src/services/`. A route handler never opens one; a repository never opens
  its own (it is handed a `Tx`, so the same primitive composes inside or outside one).
- **R9 — Repositories expose primitives, services expose use cases.** A repository
  function is one persistence step (`loadSession`, `insertAnswer`); a service function is
  one use case (`startSession`, `submitAnswer`) taking only its own arguments.

## How to detect a violation

Run from the repo root. Each command must print nothing.

```bash
# R1 — routes must not touch persistence
grep -rnE "from '\.\./(db|repo)/|from 'drizzle-orm|from 'pg'" apps/server/src/routes/

# R2 — services must not touch transport
grep -rnE "from '(hono|@hono)/|from 'hono'|from '\.\./db/schema'|from 'drizzle-orm" apps/server/src/services/
# R2 — services may reference repo modules only as types
grep -rn "from '\.\./repo/" apps/server/src/services/ | grep -v 'import type'

# R3 — domain must be pure and self-contained
grep -rnE "from '\.\./|from '(pg|drizzle-orm|hono)" apps/server/src/domain/
grep -rn "Math.random\|Date.now\|new Date()" apps/server/src/domain/

# R4 — persistence must not reach upward
grep -rnE "from '\.\./(routes|services)/|from '\.\./(app|composition)'" apps/server/src/repo/ apps/server/src/db/

# R5 — app.ts wires, it does not know a database exists
grep -nE "from './(db|repo)/|drizzle|from 'pg'" apps/server/src/app.ts | grep -vE '^[0-9]+:\s*(//|\*)'

# R6 — composition performs no I/O
grep -nE "createDb|new Pool|await " apps/server/src/composition.ts | grep -vE '^[0-9]+:\s*(//|\*)'

# R7 — console outside the logger
grep -rn "console\." apps/server/src --include='*.ts' \
  | grep -v -e '/logger.ts' -e '/index.ts' -e '/db/cli.ts' -e '\.test\.ts'

# R8 — transaction boundaries live in services/
grep -rn "\.transaction(" apps/server/src --include='*.ts' \
  | grep -v -e '/services/' -e '\.test\.ts'
```

Tests are excluded from R7/R8 only; R1–R6 apply to test files too, since a test that
reaches across a layer is evidence the seam is missing.

## Why

- Phase 2 put orchestration in the route handler. Under Postgres that handler would own
  `db.transaction()`, the `SELECT … FOR UPDATE`, and the insert-then-maybe-complete
  sequence — degrading "one transaction per use case" from a structural guarantee into a
  convention someone has to remember. `services/` exists for R8.
- A pure `domain/` (R3) is what keeps the trickiest behaviour in the codebase — replay,
  desync, completion — covered by fast, database-free tests. It is also where option-range
  validation belongs: the question knows how many options it has, so `step` answers it
  before `evaluate` runs, and a record carrying `answer_string: undefined` is never built.
- R5/R6 are what make a per-test database possible: `createApp(deps)` over module-level
  state is the difference between injecting a clone and being stuck with a singleton.

## Related

- Closure-based dependency injection — the rule that makes R5/R6 enforceable — is
  documented separately (ADR pending). Until then see the phase 4 design, *Closure-based
  dependency injection is mandatory*, and
  [phase 5](../superpowers/specs/2026-09-05-lang-tutor-phase-5-di-corrections-design.md),
  which replaced `createApp(db)` with `createApp(deps)`.
