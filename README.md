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

Phase 9 gives the learner a dictionary. Typing a word, a phrase or a sentence returns its
meanings from a language model, ranked with the most common first, each with an example
sentence in both languages; a **more** button reveals the rest and a button on each meaning
confirms the one that fits. Nothing is saved yet — this phase exists to validate the
experience, and the confirmation it shows is deliberately ahead of the storage that arrives
next. It is also the first time the server calls a third party, holds a secret, or depends
on a non-deterministic answer.

Phase 10 makes that dictionary real. A translation the model answers is written to
Postgres, and the next lookup of that string — by anyone — is served without reaching the
provider. The model is now asked for *entries*, one per headword, so typing `saw` returns
the verb `see` and the noun `saw` in one answer and writes both. The dictionary is shared
and records no learner: there is no `user_id` anywhere near it, so "my words" is not what
this builds — the second learner to ask a word benefits from the first. Nothing on the
wire changed, and `apps/mobile` has no changed file.

- Phase 1: [design](docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md) · [plan](docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md)
- Phase 2: [design](docs/superpowers/specs/2026-08-26-lang-tutor-phase-2-design.md) · [plan](docs/superpowers/plans/2026-08-26-lang-tutor-phase-2.md)
- Phase 3: [design](docs/superpowers/specs/2026-08-29-lang-tutor-phase-3-ci-design.md) · [plan](docs/superpowers/plans/2026-08-29-lang-tutor-phase-3-ci.md)
- Phase 4: [design](docs/superpowers/specs/2026-08-30-lang-tutor-phase-4-postgres-design.md) · [plan](docs/superpowers/plans/2026-09-04-lang-tutor-phase-4-postgres.md)
- Phase 5: [design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-5-di-corrections-design.md) · [plan](docs/superpowers/plans/2026-09-05-lang-tutor-phase-5-di-corrections.md)
- Phase 6: [design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-6-test-topology-design.md) · [plan](docs/superpowers/plans/2026-09-06-lang-tutor-phase-6-test-topology.md)
- Phase 7: [design](docs/superpowers/specs/2026-09-05-lang-tutor-phase-7-openapi-design.md) · [plan](docs/superpowers/plans/2026-09-06-lang-tutor-phase-7-openapi.md)
- Phase 8: [design](docs/superpowers/specs/2026-09-07-lang-tutor-phase-8-onboarding-design.md) · [plan](docs/superpowers/plans/2026-09-07-lang-tutor-phase-8-onboarding.md)
- Phase 9: [design](docs/superpowers/specs/2026-09-08-lang-tutor-phase-9-translation-design.md) · [plan](docs/superpowers/plans/2026-09-08-lang-tutor-phase-9-translation.md)
- Phase 10: [plan](docs/superpowers/plans/2026-09-10-lang-tutor-phase-10-vocabulary-persistence.md) — this phase's plan carries its design; no separate design doc was written.

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
| `providers/` | `fetch`, its own transport types, `errors`, `logger` | services, routes, domain, repo, db — and nothing but `composition.ts` may import it |

`routes/` (Hono handlers) never sees a `Db` or a repository — it does not know a
database exists. `services/` owns transaction boundaries: a use case that touches the database is
exactly one `db.transaction(...)`, so "one transaction per use case" is structural, not
a convention. (Since phase 9 a use case may touch no table at all — translation calls a
model and nothing else — which is why that rule is worded around the database rather
than around use cases.) This is why the store and the mock question pool from earlier phases are
gone rather than kept as a fallback: a second data source would mean a second place a
transaction could leak across.

Since phase 7 a route is one `createRoute` definition plus its handler, and that
definition is simultaneously the routing entry, the request validator, the response type
and the published OpenAPI description. There is no second document to keep in step,
which is the point: a response that stops matching its declared schema stops compiling.

Since phase 9 there is one more layer: `providers/` holds outbound third-party I/O behind a
two-line `LlmClient` contract declared in `services/`. A service depends on that contract and
never learns which provider satisfies it, so switching from Gemini to another vendor is one
new file in `providers/` and one changed line in `index.ts` — the same shape the
`Transaction` seam already gives the database.

Every dependency with I/O, state, or a lifecycle — a database handle, an HTTP client, a
clock, a source of randomness — follows one rule, with no opt-out: construct it only at
a composition root (`apps/server/src/index.ts`, `apps/server/src/db/cli.ts`,
`apps/mobile/src/app/_layout.tsx`) and pass it down as a closure. See
[ADR 0002](docs/adr/adr-0002-di-with-closures.md) for the rules and why each one is
enforced.

### Architecture decision records

| ADR | Decision |
|---|---|
| [0001](docs/adr/adr-0001-layered-architecture.md) | Layered architecture in `apps/server` — the import rules between `routes/`, `services/`, `domain/`, `repo/`, `db/`, `providers/` |
| [0002](docs/adr/adr-0002-di-with-closures.md) | Dependency injection via closures, constructed only at a composition root |
| [0003](docs/adr/adr-0003-openapi-wire-contract.md) | OpenAPI generated from the wire contract — one `createRoute` definition per endpoint, schemas live in `packages/core` |
| [0004](docs/adr/adr-0004-test-topology.md) | Test topology — which folder a test file is in decides whether it may touch infrastructure |
| [0005](docs/adr/adr-0005-identity-without-authentication.md) | Identity without authentication — a username identifies, it authorizes nothing |

All five are enforced by `npm run lint:arch` (17 + 7 + 6 + 7 + 3 = 40 checks, grep only, no deps,
no database) — see *Checks* below.

## Data model

Nine tables, all in `apps/server/src/db/schema.ts`:

| Table | Holds |
|---|---|
| `users` | One row per learner: a unique `username` they log in with, a `display_name`, an `age`, and their native/target language pair. The id is issued by the database, never by a client. |
| `vocab_terms` | A lemma in a language (e.g. English "run"), unique per `(language_code, lemma)`. The id is issued by the database. |
| `term_variants` | A surface form somebody actually queried — `run`, `running`, `saw` — with the language it is in and `entry_rank`, this term's position among the readings the model returned *for that form*. `UNIQUE(language_code, lower(form), entry_rank)` is both the lookup index and the guarantee that no two terms claim one reading. |
| `vocab_term_senses` | A distinct meaning of a term, with its `part_of_speech`, its source-language `example_source`, and `rank` — "most common first", within that term. |
| `term_sense_translations` | A sense's translation into a learner's native language, with the target half of the example, one row per `(sense, user_language_code)`. |
| `questions` | A generated multiple-choice question: a sense, a prompt variant, and its shuffled `options` (jsonb). |
| `sessions` | One learner's attempt at a ten-question run; `completed_at IS NULL` means still in progress. |
| `session_questions` | The ten questions assigned to a session, in order, with the per-session option shuffle. |
| `answers` | The option the learner picked for one `(session, position)`, constrained to reference a question actually assigned there. |

Since phase 10 the vocabulary tables **are** written at request time: `POST
/api/translations` writes every entry the model returned, and the next lookup of that
string is served from Postgres. The dictionary is shared and records no learner — there is
no `user_id` near these tables — so a save enriches the global dictionary rather than
anybody's word list. It is first-writer-wins and permanent: a term that has senses is never
rewritten, there is no TTL, and the only supported way to change stored content is
`npm run db:reseed`.

Two ranks, two scopes, and they are not the same number. `vocab_term_senses.rank` orders
senses *within one headword*; `term_variants.entry_rank` orders headwords *within one
form*. A lookup sorts by rank first, so a form belonging to two headwords returns them
interleaved and neither one's top sense is crowded out.

`questions` is split down the middle by `user_id`: **`user_id IS NULL` means the question
is shared** — part of the common pool every learner can be given — while a non-null
`user_id` would mean a question generated for that learner alone. Nothing writes a
per-learner question yet; the column exists so a later phase can add them without a
migration.

## Running it

Docker, then the database, then the server, then the app. The mobile app reads its
server URL from `apps/mobile/.env.local`, which Expo auto-loads and git ignores (only
`.env.example` is committed) — create it before the first run.

```bash
npm install
cp apps/mobile/.env.example apps/mobile/.env.local
npm run db:up        # Postgres + MockServer  (requires Docker)
npm run db:migrate   # schema + shared vocabulary seed
npm run server       # terminal 1
npm run mobile       # terminal 2
```

> **Migration `0003` clears the dictionary and the quiz.** It runs `TRUNCATE vocab_terms,
> sessions CASCADE` before adding its columns, so applying it drops every seeded and
> looked-up word, every question, and all session history — `answers`, `session_questions`
> and `sessions`. `users` survives. That is the deliberate price of one data shape instead
> of two, and it happens once, the first time `npm run db:migrate` runs on an existing
> database.

`npm run db:up` starts two containers: Postgres, and a MockServer instance that stands in for
the Gemini API in every test bucket. Integration and e2e tests register their own expectations
against it per test, so no test needs network access or an API key.

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

### Environment variables

Since phase 9 the server calls a third-party model, so it needs credentials to start:

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | none — the server refuses to start | Never logged. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Pointed at a MockServer namespace by every test bucket. |
| `GEMINI_MODEL` | none — the server refuses to start | `gemini-2.5-flash` is the id phase 9 was scored against. |

`npm run db:migrate` needs none of these: migrations read `loadConfig` only.

CI's `test-eval` job reads the first from the `GEMINI_API_KEY` repository secret and the
third from the `GEMINI_MODEL` repository variable, and leaves `GEMINI_BASE_URL` unset so it
takes the default. Changing the model in CI is therefore a repository-variable edit, with
no commit involved — which is also why a `test-eval` result is not fully determined by the
tree it ran against.

`gemini-2.5-flash` was chosen by measurement, not by taking the highest version number.
The newer thinking-class Flash models were tried first and are not usable here as the
provider is currently configured: `gemini-3.8-flash` writes its reasoning into the
`part_of_speech` string and omits `example` entirely, and `gemini-3.5-flash` did not answer
inside 60s. `gemini-2.5-flash` returns the contracted shape in around 4.5s and scores
100% on `npm run eval`. It is a config value, never hardcoded — a later model is a
variable change plus an eval run, not a code change.

For local work with no real key, point the server at MockServer and use any dummy value:

```bash
export GEMINI_BASE_URL=http://localhost:1080/dev GEMINI_API_KEY=dev GEMINI_MODEL=dev
```

### The recorded seed

The seed is meant to hold real provider answers, generated once against Gemini and
reviewed by hand. `src/db/content.ts` holds the quiz authoring — the string to record,
three distractors, and where the right answer is spliced in — and
`src/db/content.generated.ts` holds the recordings. `db/seed.ts` replays them through
`persistEntries`, the same write path a lookup uses, so a seeded row and a looked-up row
are indistinguishable — that is the design.

As committed today, `content.generated.ts` holds placeholders, not recordings: this
environment has no `GEMINI_API_KEY`, so `npm run content:generate` has never been run
against the real model. Each of the sixteen entries is derived mechanically from the
authored content in `content.ts` instead — one entry, one sense, a translation, a part of
speech and a sense code, and no example. The file's own header says so.

```bash
npm run content:generate            # re-record all sixteen. Needs a real key; spends money
npm run content:generate -- book    # re-record one, leaving the other fifteen untouched
npm run db:reseed                   # clear the dictionary and replay the recording
```

> **The first real recording run must be unfiltered.** The recorder stamps its header —
> "Recorded provider answers… reviewed by hand… DO NOT EDIT BY HAND" — on every run it
> makes, filtered or not. Running `npm run content:generate -- book` against today's
> placeholder file would re-record that one entry for real and stamp that header over the
> whole file, falsely marking the other fifteen placeholders as reviewed recordings. Run it
> unfiltered first, so the header becomes true of all sixteen at once. After that, the
> filter is the right tool, for the reason below.

`content:generate` needs `GEMINI_API_KEY` and `GEMINI_MODEL` and refuses to run against
MockServer. It is absent from every CI job, so a stale `content.generated.ts` is invisible
until someone looks. Always read the diff before committing one: regeneration is
non-deterministic enough at `temperature: 0` that a filterless re-record produces a
sixteen-entry diff nobody reads carefully, which is why the filter exists once every entry
is a genuine recording.

`db:reseed` is needed because `persistEntries` is first-writer-wins — running the seed
alone against a populated database writes nothing, so a re-recording would never reach it.

> **`db:reseed` drops looked-up words as well as recorded ones**, and takes session history
> with them. Nothing distinguishes a recorded row from a written one — that is the whole
> point of recording the seed — so "re-record one word" is really "reset the dictionary and
> re-record". The loss is provider calls rather than data.

To remove one bad entry during a play-test without resetting everything, delete it by hand:
`DELETE FROM vocab_terms WHERE lemma = 'whatever';` cascades to its variants, senses and
translations.

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

`POST /api/translations` reaches a paid third-party model **on a miss** — a string already
in the dictionary is answered from Postgres in milliseconds and costs nothing. Since phase
10 that is most repeat traffic, but there is still no authentication and no rate limit in
front of the endpoint, and every *new* string is a paid call. That is acceptable for a
play-test on a local network and **must not** reach a public host in this state.

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

Every push, on every branch, runs six parallel jobs on GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). `workflow_dispatch` runs the same
six by hand, which matters for the one job whose result can change without a commit.

| Job | Database | Runs | Roughly |
|---|---|---|---|
| `check-adrs` | none | `./scripts/check-adrs.sh` — every ADR's rules (ADR 0001's layering, ADR 0002's DI). Grep over the tree, so no `npm ci`, no setup step, fails in seconds | <10s |
| `check-types` | none | `npm ci`, then `npm run typecheck` — `tsc` reads `db/schema.ts` directly | 1 min |
| `test-unit` | **none, deliberately** | `npm test` | 1 min |
| `test-integration` | `npm run db:up` | `npm run db:check -w apps/server` (migration-history consistency), then `npm run db:generate -w apps/server` followed by a `git status` check that fails if it produced any change (schema↔migrations drift), then `npm run test:integration` | 1-2 min |
| `test-e2e` | `npm run db:up` | `npm run e2e` — the Playwright suite described below | 4-5 min |
| `test-eval` | **none, and no MockServer either** | `npm run eval` — the golden set against the real Gemini API, keyed by the `GEMINI_API_KEY` secret and the `GEMINI_MODEL` variable | 1 min |

`test-unit` has no database available at all. That is the point: it *proves* the
unit/integration boundary rather than assuming it, because a "unit" test that secretly
needs Postgres fails there loudly instead of passing because a database happened to be
reachable.

The two jobs that need infrastructure bring it up from `docker-compose.yml` rather than
declaring a `services:` container, so the `postgres:17` image and its healthcheck are
defined in exactly one place in the repo. They go through `npm run db:up` rather than
`docker compose` directly, for the same reason: since phase 9 that is two containers, and
MockServer's readiness has to be waited for from the host because its image is distroless
and cannot run a healthcheck of its own. Either way it has to come after
`actions/checkout` — it reads the compose file out of the tree.

`test-eval` is the odd one out, and worth understanding before you trust its colour. It
calls the real, paid Gemini API — no database, and pointedly no MockServer; the runner
refuses to start against a localhost base URL. It is therefore the only job that can fail
because a vendor shipped a model update, with nothing wrong in the diff. It uploads its
scorecard as an `eval-report` artifact on success as well as failure, which is what lets
you tell a prompt regression from a provider change; the two `npm ci` minutes dominate it,
since the ten cases themselves run concurrently in about 15 seconds. It was a separate
nightly workflow until it was folded in here — see
[ADR 0004](docs/adr/adr-0004-test-topology.md) for why that was reversed.

The jobs are independent, so a red `test-e2e` beside a green `check-types` and `test-unit`
tells you the app broke, not that the code stopped compiling. A failing `test-e2e` run uploads
a Playwright trace as a `playwright-traces` artifact; download it and open it with
`npx playwright show-trace` rather than trying to reproduce the failure locally.

Pushing again cancels the previous run for that branch.

### Nothing gates a merge yet

These six context names — `check-adrs`, `check-types`, `test-unit`, `test-integration`,
`test-e2e`, `test-eval` — are what
a branch-protection rule on `master` must list. **No such rule exists.** `master` has no
legacy branch protection, and its active ruleset ("protect muster") contains only
`deletion`, `non_fast_forward` and `pull_request` — no `required_status_checks`. A pull
request with a failing `test-integration` job is mergeable today.

That matters more now that bare `npm test` is unit-only: the two facts are individually
survivable and jointly leave no structural point at which a change that breaks the
database-backed tests is stopped before it reaches `master`. Fixing it is one ruleset
edit; it is a repository setting rather than a change to this repo, which is the only
reason it is not in the diff that introduced this section.

Two caveats before making them required. A pull request from a **fork** produces no check
runs at all, because `on: push` only fires for branches in this repository; requiring these
contexts would leave such a PR permanently unmergeable. Add a `pull_request` trigger to the
workflow first if outside contributions ever become real — and note that `test-eval` is
guarded by `if: github.repository_owner == 'victor-prp'`, because secrets are not exposed
to fork workflows and the job would otherwise fail on a missing key for a reason no outside
contributor could fix. A skipped job satisfies a required check; a failing one does not.

And `test-eval` is a third party's uptime and release schedule on the merge path. Requiring
it means an outage or a model update can block a merge that has nothing to do with either.
That is a defensible trade — it is the reason the job exists here rather than in a nightly
— but make it knowingly, and leave `test-eval` off the required list if it is not.

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
