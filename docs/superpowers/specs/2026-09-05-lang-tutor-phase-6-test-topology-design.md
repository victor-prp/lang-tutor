# Phase 6: Test topology

Implements three decisions recorded while reviewing the phase-4 pull request: unit
tests that need no infrastructure and stay fast, database-backed tests gathered under
one folder, per-test databases that say which test they served, and a CI file that
stops duplicating the Postgres definition.

Nothing here changes what is tested. This phase moves tests, re-buckets them, and
changes the lifecycle of the databases they run against.

## Goals

- `npm test` runs to completion with Docker stopped.
- Which bucket a test belongs to is decided by which folder its file is in — no
  allowlist for anyone to remember to update.
- A test database's name identifies the test it served; its `COMMENT` carries the
  detail that will not fit in an identifier.
- The `postgres:17` image and its healthcheck are defined once, in
  `docker-compose.yml`.
- CI *proves* the boundary instead of assuming it: the unit job has no database
  available at all, so a "unit" test that secretly needs one fails there.

## Non-goals

- **OpenAPI generation** (decision 3) — its own phase.
- **`packages/core` and `apps/mobile`.** Both are already entirely fast with no
  infrastructure; there is nothing to split.
- **New test coverage.** Phase 5 adds the tests that prove its seams. This phase adds
  none — it only relocates and re-buckets what exists.
- **Requiring status checks on `master`.** Surfaced while designing this phase (see
  Risks) and worth doing, but it is a repository-settings change, not a code change.

## Precondition: phase 5 must land first

Not a preference. The mixed-file splits in *File topology* extract database-free cases
that do not exist until
[phase 5](2026-09-05-lang-tutor-phase-5-di-corrections-design.md) creates the seams
that make them database-free. Attempting this phase first would move most test files
into `tests/integration/`, and phase 5 would then move several of them back.

## Decisions

| Decision | Choice | Notes |
|---|---|---|
| Mixed files (both fast and database-backed cases) | Split by bucket, into two files with mirrored paths | Sending the whole file to `integration` is simpler but creates a gravity well: new fast tests get written into the existing slow file out of convenience, and the fast bucket never grows. |
| Bare `npm test` at the root | Unit only; `test:integration` and `test:all` alongside | Chosen over the safer "everything by default". The trade — the obvious command can go green while database-backed tests never ran — is real, is mitigated in *Scripts*, and is recorded under Risks rather than treated as solved. |
| Jest config location | A new `apps/server/jest.config.js` | Two projects with per-project setup need comments to explain *why* (which JSON cannot carry). `.js` rather than `.ts` because Jest needs `ts-node` for a TypeScript config and it is not installed — adding a dependency to parse config is not worth it. |
| `tests/support/isolation.test.ts` | Moves to `tests/integration/support/` | It tests the harness rather than the app, which argues for keeping it separate — but it needs Postgres, and one allowlisted exception is how the allowlist this design removes comes back. |
| Template databases | Renamed `lang_tutor_tmpl_<worker>` → `t_tmpl_<worker>`; sweep widened from `t_test_%` to `t_%` | Fixes an existing orphan bug, not only tidiness: templates are dropped by exact name for `worker in 1..maxWorkers`, so a 4-worker run followed by a 2-worker run leaks templates 3 and 4 permanently. |
| CI job ids | `test-unit` and `test-integration`, named for what they do | An earlier draft kept the imprecise id `test` to avoid breaking a required status check. Verified against the API: `master` has no legacy branch protection, and its active ruleset ("protect muster") contains only `deletion`, `non_fast_forward` and `pull_request` — **no** `required_status_checks`. No job name is load-bearing, so accuracy wins. |

## Architecture

### Two Jest projects

`apps/server/package.json`'s `"jest"` block is replaced by `apps/server/jest.config.js`:

```js
module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/**/*.test.ts'],
      restoreMocks: true,
      resetMocks: true,
      // No globalSetup: nothing here may touch Postgres. That is the whole point,
      // and CI's test-unit job (which has no database at all) enforces it.
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      globalSetup: '<rootDir>/tests/support/globalSetup.ts',
      globalTeardown: '<rootDir>/tests/support/globalTeardown.ts',
      restoreMocks: true,
      resetMocks: true,
      testTimeout: 30000, // a clone plus a pool connection is slower than a pure unit test
    },
  ],
};
```

`tests/support/` keeps the harness itself (`globalSetup`, `globalTeardown`, `testDb`,
`dbNames`); only its one *test* file moves under `tests/integration/`.

### File topology

Straight moves, path mirrored under `tests/integration/`:

| From | To |
|---|---|
| `src/db/client.test.ts` | `tests/integration/db/client.test.ts` |
| `src/db/schema.test.ts` | `tests/integration/db/schema.test.ts` |
| `src/db/seed.test.ts` | `tests/integration/db/seed.test.ts` |
| `src/repo/questions.test.ts` | `tests/integration/repo/questions.test.ts` |
| `src/repo/sessions.test.ts` | `tests/integration/repo/sessions.test.ts` |
| `src/routes/sessions.test.ts` | `tests/integration/routes/sessions.test.ts` |
| `tests/support/isolation.test.ts` | `tests/integration/support/isolation.test.ts` |

`tests/integration/session-flow.test.ts` already sits correctly — it is the model this
generalises. Phase 5's `composition.test.ts` needs a real `Db` and belongs here too.

Staying in `src/` because they touch no infrastructure: `db/content.test.ts`,
`domain/session.test.ts`, and phase 5's `config.test.ts` (and `logger.test.ts`, if
phase 5 writes one).

The two files phase 5 leaves mixed are split:

| File | Fast half, stays in `src/` | Database half → `tests/integration/` |
|---|---|---|
| `app.test.ts` | `/health` 200 and 503, via a fake `ping` and a `sessions` stub that throws if called | "does not create a session as a side effect" |
| `services/sessions.test.ts` | `SessionNotFound` via fake repo factories | the nine database-backed cases, plus phase 5's `rng`-determinism case |

**Implementation note:** treat this table as the *expected* shape, not the authority.
The split must be re-derived from the actual tree after phase 5 lands — if a case
phase 5 was expected to make database-free turns out not to be, it belongs in
`integration` regardless of what this table says.

### Database lifecycle

Naming, cleanup timing and metadata are decision 4 of the PR review, unchanged:

- **Name:** `t_test_<slug>_<random>`, where `<slug>` is
  `expect.getState().currentTestName` lowercased, non-alphanumeric runs collapsed to
  `_`, truncated to fit Postgres's 63-byte identifier limit, and `<random>` is a short
  uniqueifier against truncation collisions.
- **Metadata:** `COMMENT ON DATABASE` carries the full untruncated test name, the test
  file path (`expect.getState().testPath`), the Jest worker id, and a creation
  timestamp. Read with `\l+` or
  `SELECT datname, shobj_description(oid, 'pg_database') FROM pg_database;`.
- **Cleanup:** `close()` still ends the connection pool — that part is load-bearing
  against Postgres's `max_connections` — but no longer drops the database. Dropping
  moves to a `t_%` sweep at the top of `globalSetup`, before templates are recreated.

Two consequences of running under two projects rather than one:

**The sweep only runs when integration tests run,** because `globalSetup` now attaches
to that project alone. Correct — a unit run creates no databases — but it means
`npm test` never reclaims anything, and the previous run's databases survive until the
next *integration* run. That is the intended inspect-afterwards behaviour, stated here
so it is not rediscovered as a leak.

**The sweep runs before template creation and covers templates too.** Because it
matches `t_%` rather than dropping templates by exact worker number, a run started with
fewer workers than the last one no longer strands the extra templates.

### Scripts

`apps/server` gains a second test script; its `test` narrows to the unit project:

```json
"test": "jest --selectProjects unit",
"test:integration": "jest --selectProjects integration"
```

The root fan-out then composes without special-casing any workspace — `mobile` and
`core` have only a `test`, and it is already fast:

```json
"test":             "npm run test:unit && echo '' && echo 'Note: unit tests only. Run npm run test:all before pushing - database-backed tests did not run.'",
"test:unit":        "npm test --workspaces --if-present",
"test:integration": "npm run test:integration --workspaces --if-present",
"test:all":         "npm run test:unit && npm run test:integration"
```

Root `test:unit` invokes each workspace's own `test` script — which for `apps/server`
is now the unit project, and for `mobile` and `core` is everything they have.

Two details in the notice that look like fussiness and are not, both verified against
real shells: it uses a second `echo ''` rather than a leading `\n`, because bash's
builtin `echo` prints `\n` literally while zsh and `sh` interpret it; and it does not
quote `npm run test:all` inside the message, because nested single quotes inside a
single-quoted script string survive only by accidental word concatenation.

`test:all` calls `test:unit` rather than `test`, so the "unit only" notice does not
print in the middle of a full run.

The notice is one of three guards on the risk this default carries, because "CI catches
it" is not sufficient on a repository where CI cannot block a merge (see Risks). The
others: the README documents `test:all` as the pre-push command, and both CI jobs run
on every push regardless.

### CI

Four jobs. The Postgres `services:` blocks are deleted; the two jobs that need a
database bring it up from `docker-compose.yml`, so the image and healthcheck are
defined once.

| Job | Database | Steps |
|---|---|---|
| `typecheck` | none | unchanged |
| `test-unit` | **none — deliberately** | `npm ci`, `npm test`. No compose step. A "unit" test that secretly needs Postgres fails here, loudly, instead of passing because a database happened to be reachable. |
| `test-integration` | `docker compose up -d --wait db` | `npm ci`, the `db:check` / `db:generate` / drift-diff steps, `npm run test:integration` |
| `e2e` | `docker compose up -d --wait db` | otherwise unchanged |

`docker compose up -d --wait db` must come after `actions/checkout`, since it reads
`docker-compose.yml` from the tree; `--wait` blocks on the healthcheck, which is what
the removed `services:` block's `options: --health-cmd` was doing.

The drift-check steps stay in `test-integration`. They need no database —
`drizzle-kit generate` and `check` never connect — so they could run in `test-unit`,
but that muddies that job's single purpose for no gain.

## Success criteria

- **`npm run db:down && npm test` passes.** The phase in one line: the default command
  works with no Docker at all.
- `npm run test:integration` with Postgres down still fails with the readable
  ``Run `npm run db:up` first`` preflight, not a bare `ECONNREFUSED`.
- No file under `apps/server/src/**/*.test.ts` imports `createTestDb` or `createDb`.
- A unit run creates zero databases: `\l` is identical before and after. (Structural,
  unlike a stopwatch assertion, which would be brittle.)
- After an integration run, `\l` shows `t_test_<slug>_…` names identifying their tests,
  and `\l+` shows full name, file, worker and timestamp.
- A second integration run sweeps them — no accumulation across runs. Running with
  `--maxWorkers=4` and then `--maxWorkers=2` strands no `t_tmpl_3` / `t_tmpl_4`.
- `grep -n "services:" .github/workflows/ci.yml` → nothing.
- `npm run typecheck`, `npm run test:all` and `npm run e2e` all green.

## Risks

**A green `npm test` on a repository where CI cannot block the merge.** This is the
sharpest risk in the phase, and it is the product of two independently reasonable
things. Unit-only is now the default command, and its mitigations all assume CI is the
backstop — but `master`'s ruleset requires no status checks at all, so a pull request
with a failing `test-integration` job is mergeable today. Separately each is
survivable; together there is no structural point at which a change that breaks the
database-backed tests is stopped before it reaches `master`. The fix is one ruleset
edit — require `typecheck`, `test-unit`, `test-integration` and `e2e` — which is a
repository setting rather than a code change, and so is listed as a non-goal, but it
should land alongside this phase rather than after it.

**Split files fragment a unit's tests.** Someone opening `src/app.test.ts` sees half
the app's tests. Mirrored paths make the other half findable; the fragmentation is
real and accepted as the cost of a fast bucket that can grow.

**The gravity well inverts.** With split files the easy mistake is no longer
"everything ends up slow" but "a fast-capable test gets added to
`tests/integration/app.test.ts` because that file was already open". Nothing structural
prevents it; only review does.

**`t_%` sweeps wider than `t_test_%`.** Widened deliberately to self-heal orphaned
templates, it now drops anything in this Postgres instance whose name begins with
`t_`. Near-zero risk in a dedicated `docker-compose.yml` container, but worth knowing
before someone hand-creates a `t_scratch` database and loses it to a test run.

**The split table depends on phase 5 landing as specified.** If a case phase 5 was
expected to make database-free turns out not to be, *File topology*'s table is wrong
for that row. Mitigated by the implementation note there: re-derive the split from the
real tree, treat the table as the expected shape.
