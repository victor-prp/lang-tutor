# lang-tutor

[![CI](https://github.com/victor-prp/lang-tutor/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/victor-prp/lang-tutor/actions/workflows/ci.yml)

A language-learning app for Hebrew speakers memorising English words and phrases.

Phase 1 ran entirely on mock data with a single multiple-choice question type. Phase 2
adds a server: it creates sessions, tracks progress, scores answers, and logs each
completed session — all in memory, no database yet. Phase 4 moves that session state,
and the question pool it draws from, into Postgres: the in-memory store and the mock
question data are both gone. The learner-facing app is unchanged.

Phase 7 changes how the server's routes are *declared*: one definition per endpoint now
serves as routing, validation, response typing and OpenAPI generation at once, and the
wire contract lives in `packages/core` as Zod schemas that every API type is inferred
from. The HTTP contract itself is untouched.

Phase 8 gives the learner a name. The anonymous UUID the app used to generate on the
device is replaced by a username they choose, a display name, an age and a language pair,
collected once at onboarding and stored server-side. The app opens on a login screen that
remembers the last username, and a session can only be started by a learner who exists —
the server no longer creates one on first sight. None of this is authentication: there is
no password, and a username proves nothing. See
[ADR 0005](docs/adr/adr-0005-identity-without-authentication.md).

- Phase 1: [design](docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md) · [plan](docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md)
- Phase 2: [design](docs/superpowers/specs/2026-08-26-lang-tutor-phase-2-design.md) · [plan](docs/superpowers/plans/2026-08-26-lang-tutor-phase-2.md)
- Phase 3: [design](docs/superpowers/specs/2026-08-29-lang-tutor-phase-3-ci-design.md) · [plan](docs/superpowers/plans/2026-08-29-lang-tutor-phase-3-ci.md)
- Phase 4: [design](docs/superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md) · [plan](docs/superpowers/plans/2026-09-04-lang-tutor-phase-4-postgres.md)
- Phase 5: [design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-5-di-corrections-design.md) · [plan](docs/superpowers/plans/2026-09-05-lang-tutor-phase-5-di-corrections.md)
- Phase 6: [design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-6-test-topology-design.md) · [plan](docs/superpowers/plans/2026-09-06-lang-tutor-phase-6-test-topology.md)
- Phase 7: [design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-7-openapi-design.md) · [plan](docs/superpowers/plans/2026-09-06-lang-tutor-phase-7-openapi.md)
- Phase 8: [design](docs/superpowers/specs/2026-09-07-lang-tutor-phase-8-onboarding-design.md) · [plan](docs/superpowers/plans/2026-09-07-lang-tutor-phase-8-onboarding.md)

## Layout

An npm-workspace monorepo.

| Path | What it is |
|---|---|
| `packages/core` | `@lang-tutor/core` — the API contract (`api/`), quiz rules (`domain/`), internal helpers (`utils/`). One runtime dependency, `zod`: since phase 7 the wire contract *is* a set of Zod schemas, and every type in `api/types.ts` is inferred from one. Consumed as TypeScript source, so there is no build step. |
| `apps/mobile` | The Expo app. Screens — login, onboarding, home, session, results and profile — plus components, theme, Hebrew copy, and the API client. |
| `apps/server` | A Hono server on `@hono/node-server`. Session state and the question pool live in Postgres, reached only through Drizzle: `routes/` (Hono handlers) call `services/` (use cases, each one transaction), which call `repo/` (query functions) and the server's own `domain/` (the session state machine), backed by `db/` (schema, migrations, the connection). The app talks to the server over HTTP; the server never lets SQL leak above `repo/`. Also consumed as TypeScript source via `tsx`, no build step. |

`utils/` is not in core's `exports` map, so it is unreachable from either app by
design. Anything a consumer needs comes from `@lang-tutor/core/api` (types) or
`@lang-tutor/core/domain` (rules) — both `apps/mobile` and `apps/server` import them.

`@lang-tutor/core/api/schemas` is a third entry point, and deliberately separate: it
exports the Zod schemas those types are inferred from. `apps/server` imports it to build
its route definitions; `apps/mobile` never does. Keeping the schemas out of `./api` is
what makes that enforceable — `./api` is type-only, so a mobile import that forgets the
`type` keyword fails loudly instead of quietly pulling Zod into the app bundle.

## Architecture

`apps/server` is layered, and the dependency arrow points one way only:

| Layer | May depend on | Must not touch |
|---|---|---|
| `routes/` | services, the wire schemas from `@lang-tutor/core/api/schemas`, `@hono/zod-openapi` | Drizzle, SQL, `db/` |
| `services/` | domain, repositories, the `Db` handle for transaction scope | Hono, `Context`, status codes, SQL |
| `domain/` | `packages/core/api` types only | pg, Hono, the clock, `Math.random` |
| `repo/` + `db/` | Drizzle, domain *types* (to return them) | services, routes, domain *logic* |

`routes/` (Hono handlers) never sees a `Db` or a repository — it does not know a
database exists. `services/` owns transaction boundaries: each use case is exactly one
`db.transaction(...)`, so "one transaction per use case" is structural, not a
convention. This is why the store and the mock question pool from earlier phases are
gone rather than kept as a fallback: a second data source would mean a second place a
transaction could leak across.

Since phase 7 a route is one `createRoute` definition plus its handler, and that
definition is simultaneously the routing entry, the request validator, the response type
and the published OpenAPI description. There is no second document to keep in step,
which is the point: a response that stops matching its declared schema stops compiling.

Every dependency with I/O, state, or a lifecycle — a database handle, an HTTP client, a
clock, a source of randomness — follows one rule, with no opt-out: construct it only at
a composition root (`apps/server/src/index.ts`, `apps/server/src/db/cli.ts`,
`apps/mobile/src/app/_layout.tsx`) and pass it down as a closure. See
[ADR 0002](docs/adr/adr-0002-di-with-closures.md) for the rules and why each one is
enforced.

### Architecture decision records

| ADR | Decision |
|---|---|
| [0001](docs/adr/adr-0001-layered-architecture.md) | Layered architecture in `apps/server` — the import rules between `routes/`, `services/`, `domain/`, `repo/`, `db/` |
| [0002](docs/adr/adr-0002-di-with-closures.md) | Dependency injection via closures, constructed only at a composition root |
| [0003](docs/adr/adr-0003-openapi-wire-contract.md) | OpenAPI generated from the wire contract — one `createRoute` definition per endpoint, schemas live in `packages/core` |
| [0004](docs/adr/adr-0004-test-topology.md) | Test topology — which folder a test file is in decides whether it may touch infrastructure |
| [0005](docs/adr/adr-0005-identity-without-authentication.md) | Identity without authentication — a username identifies, it authorizes nothing |

All five are enforced by `npm run lint:arch` (15 + 7 + 6 + 5 + 3 = 36 checks, grep only, no deps,
no database) — see *Checks* below.

## Data model

Nine tables, all in `apps/server/src/db/schema.ts`:

| Table | Holds |
|---|---|
| `users` | One row per learner: a unique `username` they log in with, a `display_name`, an `age`, and their native/target language pair. The id is issued by the database, never by a client. |
| `vocab_terms` | A lemma in a language (e.g. English "run"), unique per `(language_code, lemma)`. |
| `term_variants` | Inflected forms of a term (e.g. "run", "ran", "running") — one of them is a question's prompt. |
| `vocab_term_senses` | A distinct meaning of a term, since one lemma can have several. |
| `term_sense_translations` | A sense's translation into a learner's native language, one row per `(sense, user_language_code)`. |
| `questions` | A generated multiple-choice question: a sense, a prompt variant, and its shuffled `options` (jsonb). |
| `sessions` | One learner's attempt at a ten-question run; `completed_at IS NULL` means still in progress. |
| `session_questions` | The ten questions assigned to a session, in order, with the per-session option shuffle. |
| `answers` | The option the learner picked for one `(session, position)`, constrained to reference a question actually assigned there. |

The vocabulary and sense tables are shared content, seeded once and never written to at
request time. `questions` is split down the middle by `user_id`: **`user_id IS NULL`
means the question is shared** — part of the common pool every learner can be given —
while a non-null `user_id` would mean a question generated for that learner alone.
Phase 4 only ever writes shared rows (`user_id IS NULL`); the column exists now so a
later phase can add personalised questions without a migration.

## Running it

Docker, then the database, then the server, then the app. The mobile app reads its
server URL from `apps/mobile/.env.local`, which Expo auto-loads and git ignores (only
`.env.example` is committed) — create it before the first run.

```bash
npm install
cp apps/mobile/.env.example apps/mobile/.env.local
npm run db:up        # docker compose up -d --wait db  (requires Docker)
npm run db:migrate   # schema + shared vocabulary seed
npm run server       # terminal 1
npm run mobile       # terminal 2
```

Then press `w` for the browser, or scan the QR code with Expo Go on a phone. The
interface is Hebrew and right-to-left; browser and native RTL are not identical, so
confirm layout on a real device.

**Testing on a physical device:** the phone needs a real IP to reach the server —
`localhost` only works for the web target and simulators, which share the dev machine's
network namespace. Edit the `apps/mobile/.env.local` created above:

```bash
# edit apps/mobile/.env.local: set EXPO_PUBLIC_API_URL to your dev machine's LAN IP
# (macOS: ipconfig getifaddr en0), then restart `npm run mobile`
```

Phone and dev machine must be on the same Wi-Fi network.

## Reading the API

The server describes itself. With `npm run server` running:

| URL | What it is |
|---|---|
| <http://localhost:3001/openapi.json> | The generated OpenAPI 3.1 document |
| <http://localhost:3001/docs> | [Scalar](https://github.com/scalar/scalar) — reads the document and sends real requests from the page |

Both are always on. There is no auth here, and the API surface is already fully described
by an open-source client that calls it, so gating the documentation would add configuration
and remove no risk. What *has* changed since phase 8 is that this API now carries personal
data: a display name and an age. `POST /api/login` takes a username and no password — it
identifies a learner, it does not authenticate one, and nothing may treat it as proof of
anything. See [ADR 0005](docs/adr/adr-0005-identity-without-authentication.md).

Neither is hand-written. Every endpoint is one `createRoute` definition in
`apps/server/src/` — routing, request validation, response typing and documentation at
once — built from the Zod schemas in `packages/core/src/api/schemas.ts`. Documentation
that drifts is documentation that was written twice; this is written once.

`/docs` loads Scalar's client bundle from `cdn.jsdelivr.net`, so that page needs network
access. `/openapi.json` is generated in-process and works offline.

## Browsing the database

Postgres has no cross-database `USE` — a connection is bound to one database for its
whole lifetime, so a GUI client like the SQLTools VS Code extension needs one
connection entry per database, not a single connection that lists them all (this is a
longstanding [SQLTools limitation](https://github.com/mtxr/vscode-sqltools/discussions/760),
not something this repo's config controls). A connection with no `database` field set
falls back to the `postgres` maintenance database — that is one specific database, not
"all of them." `.vscode/settings.json` already defines a dedicated connection for
`lang_tutor`.

## Checks

```bash
npm test            # unit tests only — no Docker, no database, whole monorepo
npm run db:up       # docker compose up -d --wait db  (requires Docker)
npm run test:integration  # apps/server's database-backed tests; needs db:up
npm run test:all    # both buckets — run this before pushing
npm run typecheck   # every workspace
npm run lint:arch   # ADR 0001's layering rules + ADR 0002's DI rules — grep only, no deps, no database
```

**Run `npm run test:all` before you push.** Bare `npm test` is unit-only, so it can go
green while every database-backed test sat out; it prints a reminder saying so. CI runs
both buckets on every push either way, but no ruleset on `master` requires those checks
yet, so nothing structurally stops a merge that breaks them — see *Continuous
integration*.

Which bucket a test is in is decided by the folder its file is in, not by an allowlist:

| Folder | Bucket | Rule |
|---|---|---|
| `apps/server/src/**/*.test.ts` | `unit` | Touches no infrastructure. No `globalSetup`. Importing `createTestDb` or `createDb` here is the bug. |
| `apps/server/tests/integration/**/*.test.ts` | `integration` | Needs real Postgres. Path mirrors the `src/` path of what it tests. |
| `apps/server/tests/support/**` | neither | The harness itself — `globalSetup`, `globalTeardown`, `testDb`, `dbNames`, and the fakes. Not matched by either project. |

Two files are deliberately split across both buckets — `app.test.ts` and
`services/sessions.test.ts` — because sending a whole mixed file to `integration` creates
a gravity well: new fast tests get written into the already-slow file out of convenience
and the fast bucket never grows. The mirrored paths are what make the other half
findable. The cost is real: opening `src/app.test.ts` shows you half the app's tests.

`npm run test:integration` with the database down fails with a readable instruction
pointing at `npm run db:up`, not a bare `ECONNREFUSED` — see `globalSetup.ts`.

### Inspecting what a test ran against

Each database-backed test gets its own database, cloned from a per-worker template that
`globalSetup` migrates and seeds once. They are **not** dropped when the test ends —
`close()` only ends the connection pool — so after a run you can look at exactly what a
test left behind:

```bash
docker compose exec -T db psql -U postgres -c '\l+' | grep t_test_
```

The name is `t_test_<slug of the test name>_<random>`; the `COMMENT` carries what the
63-byte identifier could not — the full untruncated test name, the file, the Jest worker
id and a creation timestamp.

Nothing accumulates: before `globalSetup` rebuilds the templates it drops every database
matching `^t_(test|tmpl)_`, so the *next* integration run reclaims the last one's. That
the sweep covers `t_tmpl_<worker>` too is what stops a 4-worker run followed by a
2-worker run from stranding templates 3 and 4 forever — they used to be dropped by exact
worker number, so nothing ever went looking for them. That reclaiming is tied to the
*next* run, not to a timer: a run's databases sit on disk untouched for as long as you
go without running `npm run test:integration` again, and running it again is what
reclaims them — there is no separate script for it.

The pattern names both prefixes rather than matching `t_` broadly, so a database of your
own is safe from it as long as it is not called `t_test_…` or `t_tmpl_…`.

A unit run creates no databases at all, which is the property CI's `test-unit` job
enforces.

Design and plan for this layout:
[design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-6-test-topology-design.md) ·
[plan](docs/superpowers/plans/2026-09-06-lang-tutor-phase-6-test-topology.md)

## Continuous integration

Every push, on every branch, runs five parallel jobs on GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

| Job | Database | Runs | Roughly |
|---|---|---|---|
| `check-adrs` | none | `./scripts/check-adrs.sh` — every ADR's rules (ADR 0001's layering, ADR 0002's DI). Grep over the tree, so no `npm ci`, no setup step, fails in seconds | <10s |
| `check-types` | none | `npm ci`, then `npm run typecheck` — `tsc` reads `db/schema.ts` directly | 1 min |
| `test-unit` | **none, deliberately** | `npm test` | 1 min |
| `test-integration` | `docker compose up -d --wait db` | `npm run db:check -w apps/server` (migration-history consistency), then `npm run db:generate -w apps/server` followed by a `git status` check that fails if it produced any change (schema↔migrations drift), then `npm run test:integration` | 1-2 min |
| `test-e2e` | `docker compose up -d --wait db` | `npm run e2e` — the Playwright suite described below | 4-5 min |

`test-unit` has no database available at all. That is the point: it *proves* the
unit/integration boundary rather than assuming it, because a "unit" test that secretly
needs Postgres fails there loudly instead of passing because a database happened to be
reachable.

The two jobs that need a database bring it up from `docker-compose.yml` rather than
declaring a `services:` container, so the `postgres:17` image and its healthcheck are
defined in exactly one place in the repo. `docker compose up -d --wait db` has to come
after `actions/checkout` — it reads the compose file out of the tree — and `--wait`
blocks on the healthcheck, which is what the removed `services:` block's
`options: --health-cmd` was doing.

The jobs are independent, so a red `test-e2e` beside a green `check-types` and `test-unit`
tells you the app broke, not that the code stopped compiling. A failing `test-e2e` run uploads
a Playwright trace as a `playwright-traces` artifact; download it and open it with
`npx playwright show-trace` rather than trying to reproduce the failure locally.

Pushing again cancels the previous run for that branch.

### Nothing gates a merge yet

These five context names — `check-adrs`, `check-types`, `test-unit`, `test-integration`,
`test-e2e` — are what
a branch-protection rule on `master` must list. **No such rule exists.** `master` has no
legacy branch protection, and its active ruleset ("protect muster") contains only
`deletion`, `non_fast_forward` and `pull_request` — no `required_status_checks`. A pull
request with a failing `test-integration` job is mergeable today.

That matters more now that bare `npm test` is unit-only: the two facts are individually
survivable and jointly leave no structural point at which a change that breaks the
database-backed tests is stopped before it reaches `master`. Fixing it is one ruleset
edit; it is a repository setting rather than a change to this repo, which is the only
reason it is not in the diff that introduced this section.

One caveat before making them required: a pull request from a **fork** produces no check
runs, because `on: push` only fires for branches in this repository. Requiring these
contexts would leave such a PR permanently unmergeable. Add a `pull_request` trigger to
the workflow first if outside contributions ever become real.

## End-to-end test

One Playwright test drives a real Chromium through a complete ten-question session against
the real server, asserting the score matches the answers given.

```bash
npx playwright install chromium   # one time per machine, ~150MB
npm run e2e
```

It needs no servers running first — Playwright starts both itself: `apps/server`, and a
static web export of the app served on port 8082. It builds that export on every run
(~9s), which is deliberate: **the Metro dev server ignores an injected
`EXPO_PUBLIC_API_URL`** (Metro compiles the value in from `.env.local` instead), so a
static export is the only way to reliably point the app at the local test server. Your
`apps/mobile/.env.local` is never read or modified by the suite, so the Expo Go device
workflow above is unaffected.

`npm test` and `npm run test:all` deliberately do **not** run this — the workspace's
script is named `e2e`, not `test`, so neither the root fan-out nor `--if-present` picks
it up, and the unit loop stays fast.

Design and plan:
[design](docs/superpowers/specs/2026-08-26-lang-tutor-e2e-testing-design.md) ·
[plan](docs/superpowers/plans/2026-08-27-lang-tutor-e2e-testing.md)
