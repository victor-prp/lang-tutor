# Phase 5: Dependency-injection corrections

Corrects the eight dependency-injection violations catalogued under *The findings*
below, so that every collaborator in `apps/server` is *received* rather than reached
for, and so the seams that receiving them makes possible actually exist and are used.

The findings came from a review of `apps/server/src` conducted after phase 4 landed.
This spec carries the catalogue as well as the design, so it stands on its own.

## Goals

- Every collaborator in `apps/server/src` is received, not reached for: no
  `Math.random`, no `console`, no concretely-imported repository factory, no SQL in
  the wiring layer — outside the two composition roots (`index.ts`, `db/cli.ts`),
  which are where naming a concrete thing is the point.
- The production wiring becomes a value a test can construct, rather than something
  inseparable from opening a socket.
- A transaction handle and a pool handle stop sharing one type, so "one transaction
  per use case" becomes a compile-time guarantee instead of a convention.
- One real defect is fixed: a completed session is logged from *inside* the
  transaction that records it.
- Every new seam is exercised by at least one test, so none ships unproven.

## Non-goals

- **`apps/mobile`.** It had its DI pass in phase 4 (`createApiClient`,
  `createUserIdStore`, `_layout.tsx` as composition root). Untouched here.
- **`packages/core`.** Already compliant — `pickQuestions(pool, count, rng)` takes its
  randomness explicitly.
- **Converting database-backed tests into fast tests.** Phase 5 *establishes* the
  seams and proves each one once. Harvesting them — moving the bulk of the service and
  route tests off Postgres — is deliberately deferred, and constrained by the drift
  risk recorded under Risks.
- **The unit/integration test split, per-test database naming and cleanup, CI
  `docker compose` reuse, and OpenAPI generation.** These belong to
  [phase 6](2026-09-05-lang-tutor-phase-6-test-topology-design.md) and
  [phase 7](2026-09-05-lang-tutor-phase-7-openapi-design.md). The
  test split in particular depends on this phase landing first: findings 4 and 8 change
  *which* tests need a database, so splitting before them would move files twice.

## The findings

From a dependency-injection review of every file under `apps/server/src`, against the
rule phase 4's spec makes mandatory (*"Closure-based dependency injection is
mandatory"*). Line references are to the tree at commit `0e1f344`.

The structure was already largely right — factories return closures, types derive from
`ReturnType`, no `jest.mock` in the server, `routes/` never sees a `Db`. Each finding
below is a place where something is still *reached for* rather than received.

| # | Severity | Site | Issue |
|---|---|---|---|
| 1 | Critical | `services/sessions.ts:42` | `Math.random` reached for inside the service |
| 2 | Critical | `services/sessions.ts:11`, `app.ts:31`, `db/client.ts:14` | Logger reached for; the completed-session log is emitted inside the transaction |
| 3 | High | `app.ts:1,19-26` | The composition root imports `sql` and executes SQL |
| 4 | High | `app.ts:28` | `createApp(db)` builds the service itself, closing the one good seam |
| 5 | Medium | `db/client.ts:31` | A transaction handle and a pool handle share one type |
| 6 | Medium | `index.ts:6-8`, `db/cli.ts:5` | Two composition roots with the connection string copy-pasted into both |
| 7 | Medium | `index.ts:6-13` | No `main()` — env read and connection opened at import time |
| 8 | Medium | `services/sessions.ts:5-6,31-32,53` | The service imports the repository factories concretely — no seam |

The concrete costs, which are what make these more than style points:

- **1** — no test can pin which ten questions a session draws. `services/sessions.test.ts`
  can only assert `toHaveLength(SESSION_LENGTH)`; pool exhaustion, duplicate avoidance
  and deterministic ordering are all untestable without a seeded `rng`.
- **2** — `jest.spyOn(console, 'log')` at `services/sessions.test.ts:79` and `:106` is the
  same signal phase 4's spec names for `jest.mock`: a missing seam. It also mutates
  process-global state across a Jest worker. Separately, `logCompletedSession` is called
  at `services/sessions.ts:69`, *inside* `db.transaction` — if the commit fails after
  `completeSession`, stdout has already claimed a session the database never recorded.
- **3** — `app.test.ts:35-46` has to open a real pool against `localhost:1`, a port nothing
  listens on, to reach the 503 branch.
- **4** — every app-, route- and integration-level test clones a real Postgres database,
  including tests that touch no data: `routes/sessions.test.ts:43-47` asserts a 400 on a
  malformed body and still pays for a `create database … template …`.
- **5** — the shared type is one-directional in the wrong direction: a repository handed
  the *pool* instead of `tx` compiles and silently runs outside the transaction.
  `repo/sessions.test.ts:45` already does exactly that, so "one transaction per use
  case" holds only because the service happens to be the sole caller of the repository
  factories — a convention, which is what `services/` exists to stop it from being.
- **6** — `postgres://postgres:postgres@localhost:5432/lang_tutor` is written out twice,
  and `createDb`'s pool `max = 5` cannot be overridden from the environment. A separate
  process is a legitimate second composition root; the config being copy-pasted into it
  is not.
- **7** — the env read, `createDb` and `serve` all run on import, so the file cannot be
  imported without starting a listening server against a real database. Nothing in the
  suite references it. `db/cli.ts` gets this right with an explicit `main()`.
- **8** — with no seam, **every service test is a database test**. `services/sessions.test.ts`
  clones a Postgres database to assert three error branches that touch no data.

### Finding 8: two framings to discard first

Both are tempting and both push toward the wrong fix:

- *"Unit testing is impossible without module-level mocks."* Not so — nothing in the
  server uses a mock today. Service tests are merely forced to be database tests.
- *"Repetitive instantiation / boilerplate."* Not a real cost. `createSessionRepo(tx)`
  allocates a plain object of four closures, twice per request.

The single legitimate driver is the missing seam.

### The alternative rejected for finding 8

Stateless repositories whose every method takes the handle as its first parameter —
`loadSession(db, id)` — with the repository objects injected into
`createSessionService`.

This re-opens finding 5 and widens it. `PgTransaction extends PgDatabase`, so a
parameter typed `Db` accepts both handles. Today `createSessionRepo(tx)` binds the
handle **once** and every subsequent method is structurally guaranteed to be on that
transaction. With a first argument, each of `submitAnswer`'s three repository calls can
independently receive the pool and still compile:

```ts
const loaded = await sessionRepo.loadSession(tx, sessionId);   // FOR UPDATE, in the tx
await sessionRepo.insertAnswer(db, sessionId, …);              // typechecks. Not in the tx.
```

That is a partially-transactional use case that passes `tsc` and drops the
`SELECT … FOR UPDATE` serialisation the design rests on. It also converts closure
injection into parameter injection, which phase 4's spec names and rejects — and here
that instinct is protecting the transaction boundary, not merely a house style.

### Why finding 4 comes first

Every other fix adds a constructed collaborator — an `rng`, a `Logger`, a
`HealthRepo`, a pair of repository factories — and all of them have to reach the
service through `createApp`. Fix finding 4 first and each of the others is a
one-parameter addition; fix it last and the wiring gets rewritten four times. This is
also why the spec tension in *Supersedes* is not optional to resolve: the prescribed
`createApp(db)` shape cannot accommodate findings 1, 2, 3, 5 or 8 without `createApp`
constructing them itself, which is the "holds no logic" line it exists to respect.

A workable order, for the implementation plan to start from: `config.ts` and `main()`
(6, 7) first, as the smallest independent piece; then `createApp(deps)` (4), the
keystone; then the `rng` and `Logger` parameters (1, 2) with the log moved outside the
transaction; then `HealthRepo` (3); then the `Tx` type and repository-factory
injection (5, 8) as one change, since the factory type is `(tx: Tx) => SessionRepo`.

## Supersedes

Phase 4's spec prescribes `createApp(db)` — both in its *"Existing violations, all
fixed in this phase"* table and its *"Wiring, health, errors"* section. This phase
replaces that with `createApp(deps)`.

Phase 4's spec is left otherwise unedited: it is the accurate record of what phase 4
designed and shipped, and rewriting its prescriptions retroactively would make it a
worse record. It gains only a one-line forward pointer to this document, so that
`createApp(db)` cannot be followed as current guidance by someone reading phase 4
alone.

## Decisions

| Decision | Choice | Why not the alternative |
|---|---|---|
| Where the wiring lives | A `composition.ts` exporting a pure `createServerDeps(io)`, called from `index.ts`'s `main()` | Putting construction directly in `index.ts` (the DI review's literal sketch) leaves the file that decides what the real server is made of untestable, because it is inseparable from `serve()`. Extracting it makes findings 4 and 7 one fix rather than two half-fixes. |
| Service dependencies | A single destructured deps object: `createSessionService({ db, rng, logger, repos })` | Growing positional parameters to four is worse at every call site, and the house style already uses a deps object for multi-dependency factories (`createApiClient({ baseUrl, fetch })`, `createUserIdStore({ storage, randomUUID })`). |
| Logging | A two-method structural `Logger` type, with a `createConsoleLogger()` implementation | A logging library is a dependency and configuration surface for three application call sites. This interface does not foreclose putting one behind it later. |
| `db/client.ts`'s error policy | `createDb(url, { max, onError })` with `onError` required | Injecting the full `Logger` into `db/` drags the type through ~12 call sites, most of them tests, for no gain. Passing the *policy* is also more correct than passing a logger to enact a policy hardcoded in the callee. |
| Health check | `ping(): Promise<boolean>` | Throwing would leave a try/catch and therefore logic in `app.ts`, which is what "wires everything, holds no logic" exists to prevent. |
| `Tx` type | Derived: `Parameters<Parameters<Db['transaction']>[0]>[0]` | Hand-writing `PgTransaction<NodePgQueryResultHKT, typeof schema, ExtractTablesWithRelations<…>>` guesses generics that can drift from what Drizzle actually hands the callback. |
| Repository handles | `createSessionRepo(tx: Tx)`, `createQuestionRepo(tx: Tx)`; `createHealthRepo(db: Db)` | Typing only the *injected factory* as `(tx: Tx) => Repo` leaves the hole open: since `Tx` is assignable to `Db`, a `Db`-taking factory still satisfies that type by parameter contravariance. |
| Test scope | One proof per seam; database-backed happy paths untouched | See Non-goals and Risks. |

## Architecture

### The composition layer

Findings 4, 6 and 7. Three files, with the cut placed so that everything above
irreducible I/O is a pure function.

```ts
// config.ts — a pure function of its argument; reads no global
export type Config = { databaseUrl: string; port: number; poolMax: number };
export function loadConfig(env: NodeJS.ProcessEnv): Config;

// composition.ts — assembly only: no I/O, no logic, no conditionals beyond
// choosing an implementation
export type AppDeps = { sessions: SessionService; health: HealthRepo; logger: Logger };
export function createServerDeps(io: {
  db: Db;
  logger: Logger;
  rng: () => number;
}): AppDeps;

// app.ts
export function createApp(deps: AppDeps);
```

`index.ts` becomes only a `main()`, behind a `require.main === module` guard (the
pattern `e2e/globalSetup.ts` already uses), so importing it does not open a socket:

1. `loadConfig(process.env)`
2. `createConsoleLogger()` — before the pool, because step 3's `onError` closes over it
3. `createDb(config.databaseUrl, { max: config.poolMax, onError: err => logger.error('idle postgres client', err) })`
4. `createServerDeps({ db, logger, rng: Math.random })`
5. `createApp(deps)` → `serve` → `SIGTERM`/`SIGINT` handlers

`createServerDeps` receives `db`, `logger` and `rng` rather than building them
because `createDb` opens a real pool and `serve` binds a port. Those stay in `main()`;
everything above them is assembly a test can call with a per-test database and a fake
logger, with no socket and no environment.

Two consequences. `db/cli.ts` also switches to `loadConfig`, which is what actually
removes the duplicated connection string finding 6 names — a second process is a
legitimate second composition root, but the config being copy-pasted into it is not.
And after this, `app.ts` imports nothing from `drizzle-orm` and does not know a
database exists — the property `routes/` already has.

### Injected collaborators

Findings 1, 2 and 3.

**Randomness.** `createSessionService({ … rng … })`, threaded from `main()`.
`index.ts` becomes the only file in the server that names `Math.random`. Commit
`422075e` removed the defaulted `rng` from `newSessionRecord`; that guarantee was
spent immediately, because the reach-out simply moved to its only caller. This is
where it stops.

**Logging.** Shaped by the three application call sites finding 2 names — one
structured event (`services/sessions.ts`), two error reports (`app.ts`,
`db/client.ts`):

```ts
// logger.ts
export type Logger = {
  info(event: Record<string, unknown>): void;
  error(message: string, cause?: unknown): void;
};
export function createConsoleLogger(): Logger;
```

`info` takes an object because the one `info` site is already
`JSON.stringify({ session_id, user_id, questions, answers, score })`. Keeping it
structured is the reason phase 4 kept that log at all — output you can tail and grep
without opening `psql`.

`db/client.ts` takes the error *policy* instead of a logger:

```ts
export function createDb(
  connectionString: string,
  options: { max?: number; onError: (error: Error) => void },
);
```

`onError` is required — a defaulted collaborator is the violation this phase removes,
and the same one that commit `422075e` deleted from `newSessionRecord`. `max` stays an
optional scalar tuning knob, not a collaborator. `main()` passes
`err => logger.error('idle postgres client', err)`; test support passes a no-op.

The other three `console` sites in the server — the startup banner in `index.ts` and
the two in `db/cli.ts` — are left as they are. Both files are composition roots writing
to a human's terminal, and a composition root naming a concrete thing is what it is
for; the same licence that lets `index.ts` name `Math.random`. Routing a migration
CLI's `migrated and seeded …` line through a structured event logger would be worse
output, not better discipline.

**Health.** `repo/health.ts`, because `select 1` is a query and the layer table gives
queries to `repo/`:

```ts
export function createHealthRepo(db: Db): { ping(): Promise<boolean> };
export type HealthRepo = ReturnType<typeof createHealthRepo>;
```

`app.ts` then maps an outcome to a status code with no `try`/`catch` and no knowledge
of Drizzle. The cost is that *why* health failed is swallowed; acceptable because a
genuinely broken pool already surfaces through `onError` above.

**The defect.** `logCompletedSession` currently runs inside `db.transaction`, so a
commit that fails after `completeSession` leaves stdout claiming a completed session
the database never recorded. The transaction callback returns its outcome; the log
fires after the transaction resolves:

```ts
const { record, justCompleted } = await db.transaction(async (tx) => { … });
if (justCompleted) logger.info({ … });
return record;
```

The replayed early-return yields `justCompleted: false`, preserving today's behaviour
exactly: logged once on completion, never on a retry of a completed session.

### Types and repo seams

Findings 5 and 8.

```ts
// db/client.ts
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
```

Verified asymmetry — a transaction still satisfies `Db`, but the pool handle no longer
satisfies `Tx`:

```ts
const a: Db = tx;   // compiles
const b: Tx = db;   // TS2739: NodePgDatabase is missing
                    // 'schema', 'nestedIndex', 'rollback', 'setTransaction'
```

That is what turns "one transaction per use case" from a convention someone has to
remember into something `tsc` enforces. The session and question repositories move to
`Tx`; `createHealthRepo` deliberately keeps `Db`, as the one place a non-transactional
call is genuinely intended.

```ts
export type CreateSessionRepo = (tx: Tx) => SessionRepo;
export type CreateQuestionRepo = (tx: Tx) => QuestionRepo;

createSessionService({ db, rng, logger, repos: { session, question } });
```

`composition.ts` passes `{ session: createSessionRepo, question: createQuestionRepo }`,
with no default. The handle is still bound once per transaction inside the use case,
exactly as today — what changes is where the factory comes from, not when the
repository is built.

The DI review's rejected alternative — stateless repositories taking the handle as a
first argument — stays rejected for the reason given there: it lets one call in
`submitAnswer` receive `tx` and the next receive the pool, and still compile, silently
dropping the `SELECT … FOR UPDATE` serialisation the design rests on.

### Resulting layout

```
apps/server/src/
  index.ts        process — main() only, behind require.main guard
  config.ts       loadConfig(env) → Config                     [new]
  composition.ts  createServerDeps(io) → AppDeps               [new]
  logger.ts       createConsoleLogger() → Logger               [new]
  app.ts          createApp(deps) — no Db, no drizzle import

  routes/
    sessions.ts   createSessionsRouter(sessions)
    schemas.ts    Zod request schemas
  services/
    sessions.ts   createSessionService({ db, rng, logger, repos })
  domain/
    session.ts    pure
  repo/
    sessions.ts   createSessionRepo(tx: Tx)
    questions.ts  createQuestionRepo(tx: Tx)
    health.ts     createHealthRepo(db: Db)                     [new]
  db/
    client.ts     createDb(url, { max, onError }); types Db, Tx
    schema.ts  migrate.ts  seed.ts  content.ts  cli.ts
  errors.ts
```

## Testing

Every seam this phase introduces is exercised by at least one test. A seam nothing
uses is unproven — you do not know `createSessionService` accepts a fake repository
until something passes one.

| Seam | Proof | Needs Postgres |
|---|---|---|
| `rng` | Same seed twice draws the same ten question ids — the assertion that is impossible today. Reuses the `testRng(seed)` helper `repo/sessions.test.ts` already defines. | Yes |
| `Logger` | The two existing assertions (logs once on completion, no log on replay) rewritten against a capturing fake instead of `jest.spyOn(console, 'log')` | Yes |
| `HealthRepo` | `ping: async () => false` → 503; `ping: async () => true` → 200. Replaces opening a real pool against `localhost:1`. The `sessions` stub passed alongside throws if called, which also proves the health route never reaches the service. | No |
| `repos` | One branch: a fake `session` factory whose `loadSession` resolves `undefined`, asserting `SessionNotFound`. One, not all three branches the DI review lists — the rest is harvest. | No |
| `createServerDeps` | Called with a per-test database, a fake logger and a seeded rng; asserts a well-formed `AppDeps` comes back. The seam proof for the wiring layer itself. | Yes (no socket) |
| `loadConfig` | Literal `env` objects in, `Config` out: defaults when empty, overrides when set. No `process.env` mutation — which is the point of taking `env` as a parameter. | No |
| `createDb`'s `onError` | Not separately tested. Inducing a real idle-client error makes a fragile test; it is proven only by call sites being required to pass one. Recorded here rather than covered by a bad test. | — |

### What changes in existing tests

- **`repo/sessions.test.ts` (14 cases) and `repo/questions.test.ts` (5)** currently call
  `createSessionRepo(t.db)` with the pool — the exact line finding 5 cites. Under `Tx`
  this no longer typechecks. Both gain a `withTx(t.db, async (tx) => …)` helper, so they
  exercise repositories the way production does. This is the bulk of the phase's test
  diff: mechanical, but real.
- **`app.test.ts`** becomes partly database-free. Its two health cases use fakes; its
  "does not create a session as a side effect" case still runs through the real service
  to the database, because faking the whole service there is harvest.
- **`services/sessions.test.ts`** keeps its database-backed cases; two assertions change
  their mechanism (fake logger, not `jest.spyOn`), and two are added (`rng`
  determinism, `SessionNotFound` via fake repos).

## Success criteria

Checkable, not impressionistic:

- `grep -rn "console\." apps/server/src` → only `logger.ts`, `index.ts` and
  `db/cli.ts`; in particular nothing under `services/`, `repo/`, `routes/`, or
  `app.ts`, and nothing in `db/client.ts`
- `grep -rn "Math.random" apps/server/src` → only `index.ts`
- `grep -rn "jest.spyOn" apps/server` → nothing; the server then mutates no
  process-global state in any test
- `grep -rn "drizzle-orm" apps/server/src/app.ts` → nothing
- `const b: Tx = db` fails to compile
- `npm run typecheck`, `npm test` and `npm run e2e` all green

## Risks

**Drift pressure on the repository fakes.** Phase 4 recorded the decision *"real
Postgres everywhere — one driver, one code path; what tests exercise is what production
runs."* A fake-repository seam is exactly what erodes that: fakes that stop resembling
the real repository, and service tests that pass while the SQL underneath is broken.
The mitigation is scope discipline — this phase *adds* one fake-repo branch test and
changes no database-backed happy path. Replacing them later would quietly reverse a
recorded decision and should be argued explicitly, not drifted into.

**`composition.ts` as a junk drawer.** A file whose whole job is construction attracts
"just one more thing". The constraint is stated in Architecture and belongs in review:
assembly only — no logic, no conditionals beyond choosing an implementation. If it
starts making decisions, it has stopped being a composition root.

**The `withTx` helper passing for the wrong reason.** Wrapping the repository tests in
real transactions is mechanical, but a helper that swallows a rollback would let tests
report success on work the database discarded. It should be a thin pass-through to
`db.transaction`, not a try/catch.

**`Tx` depends on Drizzle's `transaction` signature.** A Drizzle major version could
change the callback's parameter type. Because `Tx` is derived rather than hand-written,
that surfaces as a compile error at the point of change rather than as a type that
silently widens back to accepting the pool.

**`index.ts` remains thin but still untested.** The `require.main` guard makes it
importable, and `createServerDeps`/`loadConfig` carry the parts worth asserting — but
the final assembly in `main()` (pool options, signal handlers, `serve`) is still only
covered by running the process, which the e2e suite does indirectly. Accepted rather
than solved.
