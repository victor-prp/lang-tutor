# Phase 4: Postgres as the storage layer

Phase 2 gave the app a server that creates sessions, scores answers, and tracks
progress — all in a `Map`, wiped on every restart. Phase 4 replaces that `Map` with
Postgres.

The learner-facing behaviour does not change. The HTTP contract does not change. The
mobile app is not touched. What changes is where session state lives, and the arrival
of a real content model underneath the question pool.

## Goals

- Session state survives a server restart.
- The question pool and its vocabulary live in the database, not in a source file.
- The content model supports more than one language pair from day one, so adding a
  second native or target language is data entry rather than a migration.
- Every test runs against real Postgres, in parallel, against isolated data.

## Non-goals

- **Auth.** `user_id` is still a client-generated UUID, unvalidated, auto-created on
  first sight.
- **Session resume.** Persistence makes it newly possible for the app to pick up an
  unfinished session, but that needs a new endpoint and mobile changes. Deferred.
- **A second language pair in the seed.** The schema supports it; the seed is
  Hebrew/English only.
- **Personalised question generation.** `questions.user_id` exists and is nullable so
  a later phase can write per-learner rows. Phase 4 writes only shared ones.
- **Deployment.** No Dockerfile, no hosted Postgres, no migrate-on-deploy. Local
  Compose and CI only.
- **API changes.** `packages/core/api/types.ts` is unchanged apart from one field
  rename (below).

## Decisions

Recorded because each was a real fork, and the reasoning matters more than the outcome
if any of them needs revisiting.

| Decision | Chosen | Why |
|---|---|---|
| How much to normalise | Fully — nine tables | No data to migrate yet, so the cost of modelling properly is at its lowest. |
| Access layer | Drizzle ORM | Schema in TypeScript, generated SQL migrations, no codegen step before `tsc`, works under `tsx`. Keeps the repo's no-build-step model. |
| Test database | Real Postgres everywhere | One driver, one code path. What tests exercise is what production runs. |
| Test isolation | A database per test, cloned from a per-worker template | Genuinely separate data per test with no reuse, and one mechanism for every kind of test. |
| Question ownership | Shared (`user_id IS NULL`), nullable for later | Copy-per-user meant 80 rows on a learner's first request and a seed fix that never reaches existing learners. Shared rows keep the seed small and tests fast. |
| Option storage | Embedded `jsonb` on `questions` | One row per question, no join, already in the shape `packages/core` expects. |
| Multi-language | In the dictionary tables, not in `questions` | Senses and per-L1 translations carry the weight; a question is a rendered artifact stamped with its language pair. |
| Completed-session stdout log | Kept | Redundant as storage, still useful as output you can tail without opening `psql`. |
| Stale-session sweep | Removed | A table has no memory pressure, and deleting completed sessions destroys exactly the history these tables exist to hold. |

## Data model

Nine tables in three groups: `users`; four that model vocabulary, shared across all
learners and languages; and four that model a learner's quiz.

### Identity and dictionary

```sql
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    native_language VARCHAR(10) NOT NULL DEFAULT 'he',   -- L1
    target_language VARCHAR(10) NOT NULL DEFAULT 'en',   -- L2
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vocab_terms (
    id TEXT PRIMARY KEY,                       -- 'vt-en-remember'
    language_code VARCHAR(10) NOT NULL,        -- L2: 'en', 'es', 'fr'
    lemma TEXT NOT NULL,                       -- 'remember', 'window', 'give up'
    part_of_speech VARCHAR(50),                -- 'verb', 'noun'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (language_code, lemma)
);

CREATE TABLE term_variants (
    id TEXT PRIMARY KEY,                       -- 'tv-en-remember-inf'
    term_id TEXT NOT NULL REFERENCES vocab_terms(id) ON DELETE CASCADE,
    form TEXT NOT NULL,                        -- 'to remember', 'remembered'
    kind TEXT NOT NULL,                        -- 'base', 'infinitive', 'past'
    UNIQUE (term_id, form)
);

CREATE TABLE vocab_term_senses (
    id TEXT PRIMARY KEY,                       -- 'sense-bank-financial'
    term_id TEXT NOT NULL REFERENCES vocab_terms(id) ON DELETE CASCADE,
    sense_code TEXT NOT NULL,                  -- 'financial_institution' vs 'river_bank'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE term_sense_translations (
    sense_id TEXT NOT NULL REFERENCES vocab_term_senses(id) ON DELETE CASCADE,
    user_language_code VARCHAR(10) NOT NULL,   -- L1: 'he', 'ru', 'es'
    translation TEXT NOT NULL,                 -- 'חלון' (he), 'окно' (ru)
    definition_notes TEXT,                     -- contextual help, in L1
    PRIMARY KEY (sense_id, user_language_code)
);
```

The chain is `term → variant` for surface forms and `term → sense → translation` for
meaning. A question prompts with a **variant** (the exact form shown to the learner) and
tests a **sense** (which meaning is being asked about). That is what lets `'to remember'`
be the prompt while `remember` is the lemma, and what would let `bank` carry two senses
without ambiguity.

### Quiz

```sql
CREATE TABLE questions (
    id TEXT PRIMARY KEY,                                  -- 'q-window'
    user_id TEXT REFERENCES users(id),                    -- NULL = shared
    sense_id TEXT NOT NULL REFERENCES vocab_term_senses(id),
    prompt_variant_id TEXT NOT NULL REFERENCES term_variants(id),
    target_language VARCHAR(10) NOT NULL,                 -- L2
    user_language_code VARCHAR(10) NOT NULL,              -- L1 the options are written in
    type VARCHAR(50) NOT NULL,                            -- 'multiple_choice'
    options JSONB NOT NULL,                               -- [{position, text, is_correct}]
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (question_options_valid(options))
);

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ                              -- NULL = in progress
);

CREATE TABLE session_questions (
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    position INT NOT NULL,                                -- 0..9, presentation order
    question_id TEXT NOT NULL REFERENCES questions(id),
    option_order INT[] NOT NULL,                          -- {2,0,3,1}: the per-session shuffle
    PRIMARY KEY (session_id, position),
    UNIQUE (session_id, position, question_id)            -- composite FK target for answers
);

CREATE TABLE answers (
    session_id UUID NOT NULL,
    position INT NOT NULL,
    question_id TEXT NOT NULL,
    selected_option_position INT NOT NULL CHECK (selected_option_position >= 0),
    answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, position),
    FOREIGN KEY (session_id, position, question_id)
        REFERENCES session_questions (session_id, position, question_id) ON DELETE CASCADE
);
```

An `options` element is `{ "position": 0, "text": "חלון", "is_correct": true }`. Drizzle
declares the column as `jsonb('options').$type<QuestionOption[]>().notNull()`, so reads
come back typed with no mapping layer.

`option_order` is a permutation of canonical positions into presentation order:
`option_order[i]` is the canonical position of the option shown at display index `i`.

### Invariants the database enforces

Embedding options costs the constraints a separate `question_options` table would have
given. One `IMMUTABLE` function restores most of them, keeping them in the database
rather than scattered through the repository:

```sql
CREATE FUNCTION question_options_valid(opts JSONB) RETURNS BOOLEAN
    LANGUAGE SQL IMMUTABLE AS $$
    SELECT jsonb_typeof(opts) = 'array'
       AND jsonb_array_length(opts) >= 2
       -- exactly one correct option
       AND jsonb_array_length(
             jsonb_path_query_array(opts, '$[*] ? (@.is_correct == true)')) = 1
       -- positions are exactly 0..n-1, and texts are distinct
       AND (SELECT count(DISTINCT (o->>'position')) = jsonb_array_length(opts)
               AND min((o->>'position')::int) = 0
               AND max((o->>'position')::int) = jsonb_array_length(opts) - 1
               AND count(DISTINCT (o->>'text')) = jsonb_array_length(opts)
            FROM jsonb_array_elements(opts) o)
$$;
```

Distinct option texts are load-bearing, not just hygienic: mapping a shuffled option
string back to its canonical position is how `option_order` is computed at session
creation, and that is what keeps `pickQuestions` in `packages/core` unchanged.

Beyond that function, `answers`' composite foreign key means the database rejects an
answer to a question that was never in that session — an invariant a `jsonb` blob of
answers could not express.

### Invariants deliberately left to the repository

- **The selected option exists on the question.** With options embedded there is
  nothing to foreign-key into. `step()` has the question loaded anyway, so it is
  checked in code.
- **A session contains only questions its learner may see.** Nullable ownership
  makes a composite foreign key impossible: a session's `user_id` is never null, so
  it could never match a shared question's null.
- **`sense_id` and `prompt_variant_id` belong to the same term.** Preventable with a
  redundant `term_id` column and two composite foreign keys. Not worth it while every
  question is seed-generated; one migration to add if hand-authored questions arrive.

## Seed content

`apps/server/src/data/mockQuestions.ts` moves to `apps/server/src/db/content.ts` and
stops being runtime data. It becomes the authoring source the seed derives five layers
of rows from, all Hebrew/English:

| From a `mockQuestions` entry | Seeded row |
|---|---|
| `vocab_entry_id`, `question` | `vocab_terms` — `language_code 'en'`, `lemma` |
| `question` | `term_variants` — `form` is the prompt as shown; `kind` is `'base'`, except `'infinitive'` for `to remember`. Always one, since every question needs a `prompt_variant_id` |
| — | `vocab_term_senses` — one per term, `sense_code 'default'` |
| `options[correct_option]` | `term_sense_translations` — `user_language_code 'he'` |
| the whole entry | `questions` — `user_id NULL`, `'en'`/`'he'`, `options` verbatim |

Sixteen of each. The seed is idempotent (`ON CONFLICT DO NOTHING`) and runs as part of
`npm run db:migrate`, so every database that exists — development, per-worker test
template, e2e — has the pool in it.

Content is deliberately **not** a migration: keeping it in TypeScript keeps it readable
and diffable, and avoids 80 hand-written `INSERT` statements going stale against the
schema.

## Server architecture

### The seam

`SessionStore`'s `get` / `set` shape does not survive normalisation — `set(record)`
would have to diff a whole record against three tables to work out what changed. It is
replaced by a repository whose methods are the operations the routes actually perform:

```ts
createSession(userId): Promise<{ sessionId: string; record: SessionRecord }>
loadSession(sessionId): Promise<SessionRecord | undefined>
recordAnswer(sessionId, position, questionId, selectedPosition, completed): Promise<void>
```

`apps/server/src/store/sessionStore.ts` and its test are deleted.

### What does not change

`apps/server/src/session.ts` is untouched — not `SessionRecord`, not `step()`, not its
replay and desync logic, not `newSessionRecord`. `packages/core/domain` is untouched.
The repository's job is to reconstitute exactly today's `SessionRecord` on read:

| `SessionRecord` field | Reconstituted from |
|---|---|
| `user_id` | `sessions.user_id` |
| `questions[i].id` | `session_questions.question_id` |
| `questions[i].question` | `term_variants.form` — the prompt |
| `questions[i].vocab_term_id` | `term_variants.term_id` |
| `questions[i].options` | `option_order.map(p => q.options[p].text)` |
| `questions[i].correct_option` | index in that permuted array where `is_correct` |
| `answers[i].answer_string` | `q.options[selected_option_position].text` |
| `answers[i].is_correct` | `q.options[selected_option_position].is_correct` |
| `complete` | `sessions.completed_at IS NOT NULL` |
| `completed_at` | `sessions.completed_at.getTime()` |

One Drizzle relational query with two `with:` levels loads the whole aggregate.

Because `step()` stays a pure function over `SessionRecord`, all of `session.test.ts`
passes unmodified. The trickiest behaviour in the codebase — replay, desync, completion —
keeps its fast, database-free tests.

**The one contract change:** `Question.vocab_entry_id` is renamed to `vocab_term_id` in
`packages/core/src/api/types.ts`. It is declared and set in fixtures but read by
nothing — not the mobile app, not the domain, not the routes — so this is a five-line
rename with no behavioural effect. Leaving it would be a stale name pointing at a table
that no longer exists.

### Transaction boundaries

`POST /api/sessions` — one transaction:

```
INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING
SELECT ... FROM questions
  WHERE (user_id IS NULL OR user_id = $1)
    AND target_language = $L2 AND user_language_code = $L1
pickQuestions(pool, 10, rng)                 -- unchanged core call
INSERT INTO sessions ...
INSERT 10 session_questions                  -- one multi-row insert
```

The language pair is read off the `users` row. Defaults of `'he'` / `'en'` reproduce
today's behaviour exactly.

`option_order` is computed per question by mapping each shuffled option string back to
its canonical position — unambiguous because `question_options_valid` guarantees
distinct texts.

`POST /api/sessions/:id/next-step` — one transaction:

```
SELECT ... FROM sessions WHERE id = $1 FOR UPDATE      -- serialises concurrent next-steps
load aggregate -> SessionRecord
step(record, question_id, option_index)                -- unchanged
if outcome is 'advanced':
    INSERT INTO answers (session_id, position = record.answers.length, ...)
    if justCompleted: UPDATE sessions SET completed_at = NOW()
    log the completed-session JSON line
```

`FOR UPDATE` and the `answers (session_id, position)` primary key are two independent
defences against a double submit — neither of which the `Map` had. The `replayed` path
takes no write and commits immediately.

### Wiring, health, errors

`createApp()` becomes `createApp(db)` so tests can inject a per-test database. `index.ts`
owns the `pg.Pool` built from `DATABASE_URL` and calls `pool.end()` on `SIGTERM` and
`SIGINT`.

`/health` finally does what its comment in `app.ts` predicted: `SELECT 1` against the
pool, `503` when it fails. That matters more than it sounds — it is what makes the e2e
suite's wait-for-server meaningful once a database has to be up first.

A Hono `onError` maps an unreachable database to `500` rather than an unhandled
rejection. `404` for an unknown session and `409` for a desynced `question_id` are
unchanged.

### Layout

```
apps/server/src/
  app.ts                  createApp(db)
  index.ts                pool, graceful shutdown
  db/
    schema.ts             the nine tables, Drizzle
    client.ts             Pool + drizzle(pool, { schema })
    content.ts            was data/mockQuestions.ts
    seed.ts               five layers of shared content
    migrate.ts            drizzle migrator, then seed
    migrations/0000_init.sql
  repo/
    sessions.ts           createSession / loadSession / recordAnswer
  routes/sessions.ts      async, against the repository
  session.ts              UNCHANGED
  routes/schemas.ts       UNCHANGED
```

## Testing

Every test runs against real Postgres. Tests run in parallel, and **each test gets its
own database with its own data** — nothing is shared between tests and nothing is
reused.

The enabler is `CREATE DATABASE ... TEMPLATE`, which Postgres implements as a file copy.
Migrating and seeding happen once per Jest worker, into a template; each test clones it
in tens of milliseconds. A template is locked while being cloned, so one template per
worker rather than one shared template — otherwise every worker serialises on it.

```
globalSetup     for w in 1..maxWorkers:
                    CREATE DATABASE lang_tutor_tmpl_$w;  migrate + seed
beforeEach      CREATE DATABASE test_${w}_${n} TEMPLATE lang_tutor_tmpl_$w
                open a pool against it (max 5 connections)
afterEach       close the pool; DROP DATABASE test_${w}_${n}
globalTeardown  drop the templates, close the admin pool
```

Eight workers at five connections each stays well inside Postgres's default
`max_connections` of 100. Net wall-clock cost is a fraction of a second across the suite:
the expensive work happens once per worker, and clones run in parallel.

One mechanism covers every kind of test — repository tests, route tests, the real-HTTP
integration test, and any future test of concurrent `next-step` behaviour. There is no
category needing different setup and no rule about which applies.

### Existing test files

| File | Fate |
|---|---|
| `src/session.test.ts` | **Unchanged.** Pure functions over `SessionRecord` |
| `src/store/sessionStore.test.ts` | **Deleted**, replaced by `repo/sessions.test.ts` |
| `src/data/mockQuestions.test.ts` | Moves to `db/content.test.ts`; shape assertions survive, plus new ones tying each entry to a lemma, variant, sense, and translation |
| `src/routes/sessions.test.ts` | Database-backed via `createApp(db)`; the synthetic 12-question pool gives way to the seeded 16. Every assertion survives — 409 on desync, replay, full ten-question run |
| `src/app.test.ts` | Gains a case: `/health` returns 503 against a broken pool |
| `tests/integration/session-flow.test.ts` | Real HTTP over a real database; otherwise as-is |
| `packages/core`, `apps/mobile` | Unchanged apart from the `vocab_term_id` fixture rename |

### New coverage

- `option_order` round-trips a permutation faithfully — the presented options and
  `correct_option` reconstruct exactly what was stored.
- A completed session's row survives and replays indefinitely, rather than being swept.
- `question_options_valid` rejects two correct options, duplicate texts, and a gap in
  positions.
- `answers`' composite foreign key rejects an answer naming a question that was not in
  the session.
- A duplicate answer insert is rejected by the primary key.
- Concurrent `next-step` requests for the same session produce one answer, not two.

### The e2e database

The Playwright suite starts its own `apps/server`, so it needs a database that outlives
the process rather than a per-test clone. Its `globalSetup` drops and recreates
`lang_tutor_e2e`, migrates and seeds it, and passes the URL to the server through the
`webServer` block's `env`. Dropping it per run keeps the suite reproducible without a
retention rule.

## Local development

A root `docker-compose.yml` with `postgres:17` and a named volume, plus root scripts:

```bash
npm run db:up        # docker compose up -d db, waits for pg_isready
npm run db:migrate   # drizzle migrations, then the shared seed
npm test             # now requires the database to be up
```

`DATABASE_URL` defaults to `postgres://postgres:postgres@localhost:5432/lang_tutor`,
with a committed `apps/server/.env.example`.

The one ergonomic tax of real-Postgres-everywhere is a fresh clone running `npm test`
and getting `ECONNREFUSED 127.0.0.1:5432` under a driver stack trace. `globalSetup`
preflights the connection and fails with the instruction instead:

```
Postgres unreachable at postgres://…:5432/postgres
Run `npm run db:up` first (requires Docker).
```

## CI

The `test` and `e2e` jobs each gain a service container. `typecheck` deliberately does
not: Drizzle needs no codegen, so `tsc` reads `db/schema.ts` directly and that job stays
a clean one-minute compile check.

```yaml
services:
  postgres:
    image: postgres:17
    env:
      POSTGRES_PASSWORD: postgres
    options: >-
      --health-cmd pg_isready --health-interval 10s
      --health-timeout 5s --health-retries 5
    ports: ['5432:5432']
```

One new step in `test`: **`drizzle-kit check`, to catch schema drift.** `schema.ts` and
the committed migrations can silently diverge when someone edits the schema and forgets
to generate. Without this it fails at deploy time; with it, it is a red check on the
pull request.

The three branch-protection contexts — `typecheck`, `test`, `e2e` — are unchanged.

## Dependencies

Four: `drizzle-orm` and `pg` at runtime, `drizzle-kit` and `@types/pg` in development.
No build step, no codegen, no engine binary. The repo's `tsx` model holds.

## Documentation

The README gains Docker as a prerequisite, `db:up` and `db:migrate` in the run
instructions, a note that tests require the database, and a short data-model section
describing the nine tables and the shared-versus-per-learner split.

## Risks

- **`npm test` now requires Docker.** The largest change to how this repo feels to work
  in. The preflight message mitigates it; nothing eliminates it.
- **Schema drift between `schema.ts` and the committed migrations.** Caught by
  `drizzle-kit check` in CI, not by anything local.
- **`CREATE DATABASE` privileges.** The per-test isolation strategy needs them. Fine
  against local and CI Postgres; a hosted provider that forbids it would force a
  schema-per-test fallback.
- **The seed is Hebrew/English only.** The schema supports more, but nothing proves the
  multi-language paths work until a second pair exists. The pick query filters on both
  language columns from day one, so at least the query is not accidentally correct.
