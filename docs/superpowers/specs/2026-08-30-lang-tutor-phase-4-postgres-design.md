# Phase 4: Postgres as the storage layer

Phase 2 gave the app a server that creates sessions, scores answers, and tracks
progress — all in a `Map`, wiped on every restart. Phase 4 replaces that `Map` with
Postgres.

The learner-facing behaviour does not change and the HTTP contract does not change.
What changes is where session state lives, the arrival of a real content model
underneath the question pool, and — across both apps — a dependency-injection rule that
becomes mandatory rather than aspirational.

## Goals

- Session state survives a server restart.
- The question pool and its vocabulary live in the database, not in a source file.
- The content model supports more than one language pair from day one, so adding a
  second native or target language is data entry rather than a migration.
- Every test runs against real Postgres, in parallel, against isolated data.
- One dependency-injection pattern across both apps, applied without exception, so
  nothing in the codebase reaches for a collaborator it was not given.

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
- **Any change to what the learner sees.** `apps/mobile` *is* edited, but only to
  satisfy the dependency-injection rule below. No screen, no string, no behaviour
  changes.

One behaviour change is unavoidable and deliberate: an `option_index` beyond the
question's last option currently returns `200` with `answer_string: undefined`, counted
as incorrect. That would now write a broken row, so it becomes a `400`. Zod bounds the
field below but cannot bound it above, since the limit depends on the question.

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
| Dependency injection | Closure-based, mandatory everywhere | One pattern, no exceptions to remember. Removes `jest.mock` from the codebase and is what makes a database per test possible at all. |
| Classes | Only where the language requires one | `class` earns its place for `Error` subclasses and for instances we consume (`pg.Pool`). A class holding stateless methods is a module with extra ceremony. |
| Completed-session stdout log | Kept | Redundant as storage, still useful as output you can tail without opening `psql`. |
| Stale-session sweep | Removed | A table has no memory pressure, and deleting completed sessions destroys exactly the history these tables exist to hold. |

## Architecture

### Layers

Five, with a strict inward dependency rule. Nothing points outward.

```
  index.ts          process        config, pg.Pool, serve, SIGTERM
  app.ts            composition    createApp(db) — wires everything, holds no logic
        │
        ▼
  routes/           transport      Hono. Parse, validate, map outcome → status code
        │
        ▼
  services/         application    use cases. Owns the transaction boundary
        │
        ├──────────────────────┐
        ▼                      ▼
  domain/           domain     repo/ + db/     persistence
  packages/core                               Drizzle, SQL
  pure functions, no I/O
```

| Layer | May depend on | Must not touch |
|---|---|---|
| `routes/` | services, domain types, zod schemas | Drizzle, SQL, `db/` |
| `services/` | domain, repositories, the `Db` handle for transaction scope | Hono, `Context`, status codes, SQL |
| `domain/` | `packages/core/api` types only | pg, Hono, the clock, `Math.random` |
| `repo/` + `db/` | Drizzle, domain *types* (to return them) | services, routes, domain *logic* |

`packages/core/domain` and the server's `domain/` are both the domain layer, split by
audience rather than role: core holds rules either side might need (`pickQuestions`,
`evaluate`, `score`), the server's holds the session state machine only a server has
(`step`, `SessionRecord`). That split is why phase 1 could run the quiz client-side.

Phase 2 put the orchestration in the route handler, which was harmless while
persistence was a `Map`. It stops being harmless here: the handler would own
`db.transaction()`, the `SELECT … FOR UPDATE`, and the insert-then-maybe-complete
sequence. A transport layer owning transaction boundaries is what layering exists to
prevent, and it degrades "one transaction per use case" from a structural guarantee
into a convention someone has to remember. Hence `services/`.

### Closure-based dependency injection is mandatory

**Every dependency is received, never reached for. This is a requirement, not a
preference, and it has no opt-out.**

A dependency is anything with I/O, state, or a lifecycle: a database handle, an HTTP
client, a key-value store, a clock, a source of randomness. The rule for each of them:

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

```ts
// repo/sessions.ts — captures the handle, exposes primitives
export function createSessionRepo(db: Db) {
  return {
    loadSession:     (id: string) => …,
    insertSession:   (userId: string, picked: Question[]) => …,
    insertAnswer:    (id: string, position: number, questionId: string, selected: number) => …,
    completeSession: (id: string) => …,
  };
}
export type SessionRepo = ReturnType<typeof createSessionRepo>;

// services/sessions.ts — captures db, owns the transaction, derives the repo inside.
// Exports one factory and one type. Nothing else.
export function createSessionService(db: Db) {
  return {
    startSession: (userId: string) =>
      db.transaction(async (tx) => {
        const sessions = createSessionRepo(tx);
        const questions = createQuestionRepo(tx);
        const user = await sessions.upsertUser(userId);
        const pool = await questions.loadQuestionPool(
          user.targetLanguage, user.nativeLanguage, userId);
        const record = newSessionRecord(userId, pool, Math.random);
        const sessionId = await sessions.insertSession(userId, record.questions);
        return { sessionId, record };
      }),

    submitAnswer: (sessionId: string, questionId: string, optionIndex: number) =>
      db.transaction(async (tx) => {
        const repo = createSessionRepo(tx);
        const record = await repo.loadSession(sessionId);   // SELECT … FOR UPDATE
        …
      }),
  };
}
export type SessionService = ReturnType<typeof createSessionService>;
```

A use case takes only its own arguments — `startSession(userId)`, not
`startSession(repo, userId)`. The repository is created *inside*, from the transaction,
because the handle genuinely varies per transaction and does not exist when
`createSessionService(db)` runs. Exporting a second `startSession(repo, …)` as a test
seam is explicitly not done: it would be parameter injection wearing this rule's
clothes, and it would give routes a function they must never call.

The layer above never sees a `Db` or a repository. `routes/` does not know a database
exists.

### Existing violations, all fixed in this phase

The codebase uses closure DI in exactly one place — `createSessionsRouter(store, pool)`.
Everywhere else it either constructs its own dependencies or imports them. All of it is
brought in line here:

| Site | Violation | Fix |
|---|---|---|
| `apps/server/src/app.ts` | `createApp()` builds its own `createSessionStore()` and imports `mockQuestions` | `createApp(db)`; the service is constructed from the injected handle |
| `apps/server/src/store/sessionStore.ts` | `insert(record, now = Date.now())` — a defaulted clock, the thing `quiz.ts` forbids for `rng` | File deleted |
| `apps/mobile/src/api/client.ts` | `createSession` / `nextStep` are bare module functions reading `process.env` inside themselves | `createApiClient({ baseUrl, fetch })` returning closures |
| `apps/mobile/src/userId.ts` | `getOrCreateUserId` imports `AsyncStorage` and `expo-crypto` directly — no seam, which is why it is the only file in the repo needing `jest.mock` | `createUserIdStore({ storage, randomUUID })` |
| `apps/mobile/src/hooks/useSession.tsx` | imports `createSession`, `nextStep`, `getOrCreateUserId` directly | `SessionProvider` receives `api` and `userIdStore`; `app/_layout.tsx` constructs them |

`EXPO_PUBLIC_API_URL` must stay a literal `process.env.EXPO_PUBLIC_API_URL` reference
somewhere, because Metro only inlines `EXPO_PUBLIC_*` when it sees one — see the comment
in `client.ts`. The rule is satisfied by moving that literal to `app/_layout.tsx`, the
composition root, and passing the value in. The constraint is respected; the read just
happens where every other dependency is constructed.

Two consequences of finishing this:

- The repo's only two `jest.mock` calls, both in `apps/mobile/src/userId.test.ts`,
  disappear — the fakes become arguments. `client.test.ts` stops swapping `global.fetch`
  and injects one instead, so it no longer mutates process-global state that leaks
  across test files in a worker.
- `apps/mobile` is edited in a phase otherwise about the server. No behaviour changes;
  see the non-goals.

### What is not dependency injection

Pure functions take their inputs as parameters. That is not DI and the rule does not
apply to them: `pickQuestions(pool, count, rng)` and `newSessionRecord(userId, pool, rng)`
keep their signatures. `rng` there is a domain input, not a collaborator — and
`packages/core` is consumed by both apps as source, so wrapping it in a factory would
change a shared contract to no benefit. `quiz.ts`'s existing rule (no default argument
for `rng`, so a server cannot inherit `Math.random` by accident) is the same principle
enforced one level down.

### Classes

Used only where the language requires one or where we consume an instance we did not
write:

- `Error` subclasses. `ApiError` in `client.ts` stays as-is, and any typed server error
  (`SessionNotFound`) is a class, because `instanceof` in Hono's `onError` is the
  cleanest way to map a domain failure to a status code.
- `pg.Pool` — real lifecycle, real mutable state. Constructed in `index.ts`.

Nothing else. A class holding only stateless methods is a module with extra ceremony,
and `this` breaks when a method is passed as a callback, which a closure cannot do.

### Naming

Named imports are the house style — one namespace import exists in the whole codebase —
so the module path is erased at the call site. Which gives the rule:

> **An export name must read correctly with its file path stripped away.**

That is why `session.ts` exports `sessionScore` and `missedQuestions` rather than
`score` and `missed`: the bare verbs are taken by `packages/core/domain`.

| Layer | File | Exports |
|---|---|---|
| routes | `routes/sessions.ts` | `createSessionsRouter(sessions: SessionService)` |
| services | `services/sessions.ts` | `createSessionService`, type `SessionService` — and nothing else |
| domain | `domain/session.ts` | `step`, `positionOf`, `currentQuestion`, `sessionScore`, `missedQuestions`, `newSessionRecord` — unchanged, file moved |
| repo | `repo/sessions.ts` | `createSessionRepo`, type `SessionRepo` |
| repo | `repo/questions.ts` | `createQuestionRepo` with `loadQuestionPool`, type `QuestionRepo` |
| db | `db/client.ts` | `createDb`, type `Db` |
| db | `db/migrate.ts` | `runMigrations`, `seedContent` |

`loadQuestionPool`, not `loadPool`: `pg.Pool` now exists in this codebase, and
`loadPool` would read like it returns a connection pool.

One type for the Drizzle handle, not two. `Db` covers both a database and a
transaction, which are structurally compatible, so a service passes its `tx` wherever a
`Db` is expected.

Avoided: `SessionService` / `SessionRepo` as *class* names (there are no such classes);
`SessionAPI` (in this repo `api` already means the wire contract in
`packages/core/api`); `I` prefixes and `Impl` suffixes; and `utils/` or `helpers/` in
any new layer.

Files are camelCase, matching `sessionStore.ts` and `mockQuestions.ts`. The directory
names the layer, the file names the subject — plural in `repo/`, `services/`, `routes/`
where the module acts over a collection, singular in `domain/session.ts` for the rules
of one session.

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

## The session flow

### The seam

`SessionStore`'s `get` / `set` shape does not survive normalisation — `set(record)`
would have to diff a whole record against three tables to work out what changed. It
splits in two, along the layer boundary: a repository of persistence primitives, and a
service that composes them inside a transaction.

```ts
// repo/sessions.ts — createSessionRepo(db) returns these, closing over the handle
upsertUser(userId): Promise<{ nativeLanguage: string; targetLanguage: string }>
loadSession(sessionId): Promise<SessionRecord | undefined>
insertSession(userId, picked): Promise<string>
insertAnswer(sessionId, position, questionId, selectedPosition): Promise<void>
completeSession(sessionId): Promise<void>

// services/sessions.ts — createSessionService(db) returns these
startSession(userId): Promise<{ sessionId: string; record: SessionRecord }>
submitAnswer(sessionId, questionId, optionIndex): Promise<StepOutcome>
```

Primitives rather than use-case-shaped methods, because a repository that opens its own
transaction cannot be composed — nothing above it could make two writes atomic. Since
`createSessionRepo` is handed a transaction, the same functions work inside or outside
one.

`apps/server/src/store/sessionStore.ts` and its test are deleted.

### Reconstituting `SessionRecord`

`session.ts` moves to `domain/session.ts` so the layer is visible in the path, and its
*contents* are untouched — not `SessionRecord`, not `step()`, not its replay and desync
logic, not `newSessionRecord`. `packages/core/domain` is untouched too. The repository's
job is to reconstitute exactly today's `SessionRecord` on read:

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

Three small queries inside the transaction load the aggregate: the `sessions` row
(`FOR UPDATE`), then `session_questions` joined to `questions` and `term_variants`, then
`answers`. Explicit joins rather than Drizzle's relational `with:`, which would require
a `relations()` declaration for every table to buy nothing here.

Because `step()` stays a pure function over `SessionRecord`, all of `session.test.ts`
passes unmodified (only its import path moves). The trickiest behaviour in the codebase — replay, desync, completion —
keeps its fast, database-free tests.

**The one contract change:** `Question.vocab_entry_id` is renamed to `vocab_term_id` in
`packages/core/src/api/types.ts`. It is declared and set in fixtures but read by
nothing — not the mobile app, not the domain, not the routes — so this is a five-line
rename with no behavioural effect. Leaving it would be a stale name pointing at a table
that no longer exists.

### Transaction boundaries

Both boundaries live in `services/sessions.ts`. A route handler never opens one.

`POST /api/sessions` — `createSessionService(db).startSession`, one transaction:

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

`POST /api/sessions/:id/next-step` — `submitAnswer`, one transaction:

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

### Resulting layout

```
apps/server/src/
  index.ts                process — pool, createDb, serve, graceful shutdown
  app.ts                  composition root — createApp(db)

  routes/                 transport
    sessions.ts           createSessionsRouter(sessions: SessionService)
    schemas.ts            zod — UNCHANGED

  services/               application — NEW
    sessions.ts           createSessionService; startSession, submitAnswer

  domain/                 pure
    session.ts            moved from src/session.ts, contents UNCHANGED

  repo/                   persistence primitives, closing over a Db
    sessions.ts           createSessionRepo
    questions.ts          createQuestionRepo

  db/                     infrastructure
    schema.ts             the nine tables, Drizzle
    client.ts             createDb — Pool + drizzle(pool, { schema })
    content.ts            was data/mockQuestions.ts
    seed.ts               five layers of shared content
    migrate.ts            runMigrations, seedContent
    migrations/0000_init.sql

apps/mobile/src/
  app/_layout.tsx         composition root — constructs api + userIdStore
  api/client.ts           createApiClient({ baseUrl, fetch })
  userId.ts               createUserIdStore({ storage, randomUUID })
  hooks/useSession.tsx    SessionProvider receives its dependencies
```

`apps/server/src/data/` and `apps/server/src/store/` are both removed.

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

### Constraints the isolation strategy puts on the architecture

These are not testing details; they are why the dependency-injection rule is mandatory.

- **No module-level mutable state.** An `export const db = drizzle(new Pool(…))` in
  `db/client.ts` would give every test in a worker one connection to one database, and
  the per-test clone becomes unreachable. `createDb(url)` plus `createApp(db)` is what
  makes per-test databases possible.
- **No `process.env` read at import time.** A test resolves its own URL and passes it
  in. Nothing rewrites the environment to point somewhere else.
- **No `jest.mock`.** Jest resets the module registry per test *file*, so module mocks
  cannot leak between parallel tests — but they are also unnecessary here, because every
  dependency arrives as an argument. A hand-written fake satisfies `SessionRepo`
  structurally, so an incomplete one is a compile error rather than a runtime
  `undefined is not a function`.
- **Never mutate process-global state in a test.** Module registries reset per file; the
  worker *process* does not. `process.env`, `jest.useFakeTimers()`, and a swapped
  `global.fetch` all leak across files in the same worker. This is why
  `client.test.ts` injects `fetch` instead of replacing the global.

Time comes from `NOW()` in SQL and randomness from an injected `rng`, so phase 4 has no
reason to fake a clock — normally the largest single source of cross-test interference.

### Existing test files

| File | Fate |
|---|---|
| `src/session.test.ts` | Moves to `src/domain/session.test.ts`; **contents unchanged.** Pure functions over `SessionRecord` |
| `src/store/sessionStore.test.ts` | **Deleted**, replaced by `repo/sessions.test.ts` |
| `src/data/mockQuestions.test.ts` | Moves to `db/content.test.ts`; shape assertions survive, plus new ones tying each entry to a lemma, variant, sense, and translation |
| `src/routes/sessions.test.ts` | Database-backed via `createApp(db)`; the synthetic 12-question pool gives way to the seeded 16. Every assertion survives — 409 on desync, replay, full ten-question run |
| `src/app.test.ts` | Gains a case: `/health` returns 503 against a broken pool |
| `tests/integration/session-flow.test.ts` | Real HTTP over a real database; otherwise as-is |
| `packages/core` | Unchanged apart from the `vocab_term_id` fixture rename |
| `apps/mobile/src/userId.test.ts` | Both `jest.mock` calls deleted; `createUserIdStore` receives fake `storage` and `randomUUID` as arguments |
| `apps/mobile/src/api/client.test.ts` | Stops swapping `global.fetch`; `createApiClient` receives a fake `fetch` and `baseUrl` |

New: `src/services/sessions.test.ts`, against the per-test database like every other
database-backed test. There is no fake-repository option, by construction: a service
receives only a `Db`, so the only way to substitute the repository would be an exported
seam this design rules out. The services are three lines of orchestration over a pure
domain — the logic worth testing in isolation already lives in `domain/session.ts` and
needs no database at all.

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

It also gains a short statement of the layering and the closure-DI rule, since that rule
now governs both apps and is the kind of convention a contributor has to be told rather
than infer.

## Risks

- **`npm test` now requires Docker.** The largest change to how this repo feels to work
  in. The preflight message mitigates it; nothing eliminates it.
- **Schema drift between `schema.ts` and the committed migrations.** Caught by
  `drizzle-kit check` in CI, not by anything local.
- **`CREATE DATABASE` privileges.** The per-test isolation strategy needs them. Fine
  against local and CI Postgres; a hosted provider that forbids it would force a
  schema-per-test fallback.
- **`apps/mobile` is refactored in a server phase.** Four files change to satisfy the
  DI rule, including the `SessionProvider` that every screen consumes. No behaviour
  changes, and the e2e suite drives the real app end to end, so a regression here fails
  a check rather than reaching a learner.
- **The seed is Hebrew/English only.** The schema supports more, but nothing proves the
  multi-language paths work until a second pair exists. The pick query filters on both
  language columns from day one, so at least the query is not accidentally correct.
