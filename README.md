# lang-tutor

[![CI](https://github.com/victor-prp/lang-tutor/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/victor-prp/lang-tutor/actions/workflows/ci.yml)

A language-learning app for Hebrew speakers memorising English words and phrases.

Phase 1 ran entirely on mock data with a single multiple-choice question type. Phase 2
adds a server: it creates sessions, tracks progress, scores answers, and logs each
completed session — all in memory, no database yet. Phase 4 moves that session state,
and the question pool it draws from, into Postgres: the in-memory store and the mock
question data are both gone. The learner-facing app is unchanged.

- Phase 1: [design](docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md) · [plan](docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md)
- Phase 2: [design](docs/superpowers/specs/2026-08-26-lang-tutor-phase-2-design.md) · [plan](docs/superpowers/plans/2026-08-26-lang-tutor-phase-2.md)
- Phase 3: [design](docs/superpowers/specs/2026-08-29-lang-tutor-phase-3-ci-design.md) · [plan](docs/superpowers/plans/2026-08-29-lang-tutor-phase-3-ci.md)
- Phase 4: [design](docs/superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md) · [plan](docs/superpowers/plans/2026-09-04-lang-tutor-phase-4-postgres.md)

## Layout

An npm-workspace monorepo.

| Path | What it is |
|---|---|
| `packages/core` | `@lang-tutor/core` — the API contract (`api/`), quiz rules (`domain/`), internal helpers (`utils/`). No runtime dependencies. Consumed as TypeScript source, so there is no build step. Unchanged by phase 4: both apps still import only `api/` and `domain/` from it. |
| `apps/mobile` | The Expo app. Screens, components, theme, Hebrew copy, and the API client. |
| `apps/server` | A Hono server on `@hono/node-server`. Session state and the question pool live in Postgres, reached only through Drizzle: `routes/` (Hono handlers) call `services/` (use cases, each one transaction), which call `repo/` (query functions) and the server's own `domain/` (the session state machine), backed by `db/` (schema, migrations, the connection). The app talks to the server over HTTP; the server never lets SQL leak above `repo/`. Also consumed as TypeScript source via `tsx`, no build step. |

`utils/` is not in core's `exports` map, so it is unreachable from either app by
design. Anything a consumer needs comes from `@lang-tutor/core/api` (types) or
`@lang-tutor/core/domain` (rules) — both `apps/mobile` and `apps/server` import them.

## Architecture

`apps/server` is layered, and the dependency arrow points one way only:

| Layer | May depend on | Must not touch |
|---|---|---|
| `routes/` | services, domain types, zod schemas | Drizzle, SQL, `db/` |
| `services/` | domain, repositories, the `Db` handle for transaction scope | Hono, `Context`, status codes, SQL |
| `domain/` | `packages/core/api` types only | pg, Hono, the clock, `Math.random` |
| `repo/` + `db/` | Drizzle, domain *types* (to return them) | services, routes, domain *logic* |

`routes/` (Hono handlers) never sees a `Db` or a repository — it does not know a
database exists. `services/` owns transaction boundaries: each use case is exactly one
`db.transaction(...)`, so "one transaction per use case" is structural, not a
convention. This is why the store and the mock question pool from earlier phases are
gone rather than kept as a fallback: a second data source would mean a second place a
transaction could leak across.

Every dependency with I/O, state, or a lifecycle — a database handle, an HTTP client, a
clock, a source of randomness — follows one rule, with no opt-out:

1. **Construct at the composition root.** `apps/server/src/index.ts` for the server,
   `apps/mobile/src/app/_layout.tsx` for the app. Nowhere else calls a constructor.
2. **Capture it in a `createX` factory** that returns an object of closures, and derive
   the type with `ReturnType<typeof createX>`.
3. **Pass the resulting object down.** A consumer names what it needs in its
   parameters.
4. **No module-level mutable state.** No `export const db = …`, no `process.env` read
   at import time, no singleton caches.
5. **No `jest.mock`, anywhere.** A test supplies a fake by passing one. If a test needs
   `jest.mock`, that is the signal a seam is missing — fix the seam, not the test.

A contributor cannot infer this from reading any single file, so it is written down
here rather than left implicit. See the [phase 4 design doc](docs/superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md)
for the reasoning and the violations it fixed.

## Data model

Nine tables, all in `apps/server/src/db/schema.ts`:

| Table | Holds |
|---|---|
| `users` | One row per learner id, with their native/target language pair. |
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

## Checks

```bash
npm run db:up     # docker compose up -d --wait db  (requires Docker) — npm test needs it running
npm test          # every workspace, including apps/server's real-HTTP integration test
npm run typecheck # every workspace
```

`npm test` needs the database up: `apps/server`'s tests connect to real Postgres, one
database per test, cloned from a per-worker template built in `globalSetup`. Run it
against a fresh clone with the database down and you get a readable instruction
pointing at `npm run db:up`, not a bare `ECONNREFUSED` — see `globalSetup.ts`.

## Continuous integration

Every push, on every branch, runs both of the above plus the end-to-end suite below on GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) as three parallel jobs:

| Job | Runs | Roughly |
|---|---|---|
| `typecheck` | `npm run typecheck` — database-free, `tsc` reads `db/schema.ts` directly | 1 min |
| `test` | `npm run db:check -w apps/server` (migration-history consistency check), then `npm run db:generate -w apps/server` followed by a `git status` check that fails if it produced any change (schema↔migrations drift check), then `npm test`, all against a `postgres:17` service container | 1-2 min |
| `e2e` | `npm run e2e` — the Playwright suite described below, against its own `postgres:17` service container | 4-5 min |

The jobs are independent, so a red `e2e` beside a green `typecheck` and `test` tells you
the app broke, not that the code stopped compiling. A failing `e2e` run uploads a
Playwright trace as a `playwright-traces` artifact; download it and open it with
`npx playwright show-trace` rather than trying to reproduce the failure locally.

Pushing again cancels the previous run for that branch.

These three context names — `typecheck`, `test`, `e2e` — are what a branch-protection
rule on `master` must list to gate merges on CI. No such rule is configured yet; adding
one is a repository setting rather than a change to this repo.

One caveat before making them required: a pull request from a **fork** produces no check
runs, because `on: push` only fires for branches in this repository. Requiring these
contexts would leave such a PR permanently unmergeable. Add a `pull_request` trigger to
the workflow first if outside contributions ever become real.

The Node version comes from `.nvmrc`, which is also what `nvm use` reads — keep local and
CI on the same major version by changing that one file.

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

`npm test` deliberately does **not** run this — the workspace's script is named `e2e`, not
`test`, to keep the unit loop fast.

Design and plan:
[design](docs/superpowers/specs/2026-08-26-lang-tutor-e2e-testing-design.md) ·
[plan](docs/superpowers/plans/2026-08-27-lang-tutor-e2e-testing.md)
