# ADR 0004: Test topology — folder decides the bucket

- **Status:** Accepted
- **Date:** 2026-09-07
- **Source:** [phase 6 design](../superpowers/specs/2026-09-05-lang-tutor-phase-6-test-topology-design.md)

## Decision

Which bucket a test belongs to is decided by which folder its file is in, with no
allowlist for anyone to remember to update.

```
apps/server/src/**/*.test.ts          apps/server/tests/integration/**/*.test.ts
      unit bucket                            database bucket
  Docker stopped, no pool                 globalSetup clones a database,
  (R1-R3 forbid the imports                hands a pool to each test
   that would let one in)
              │                                        │
              └───────────────┬────────────────────────┘
                               ▼
                  apps/server/tests/support/
                  the test composition root
        createTestDb, dbNames, withTx, globalSetup/globalTeardown —
        reachable from tests/integration/ freely; a src test may
        take fakes.ts and testRng.ts, nothing else (R3). Holds no
        test files of its own (R4).
```

`apps/server/src/**/*.test.ts` must run with Docker stopped and touch no
infrastructure. `apps/server/tests/integration/**/*.test.ts` is the database bucket.
`apps/server/tests/support/` is the test composition root — the only place that may
create a database, open a pool, or hold Jest's `globalSetup`/`globalTeardown` — and it
holds no test files of its own.

`apps/server/tests/eval/` is the third bucket: the opt-in real-model code. Two things live
there — `npm run eval`, which scores the prompt, and `npm run content:generate`, the
recorder that produces `src/db/content.generated.ts`. The bucket is defined by *calling a
real language model*, which describes both; the recorder is not an eval and is not scored,
it shares the bucket because it shares the provider client, and putting it in `scripts/`
instead would have meant a third exemption in [ADR 0001](adr-0001-layered-architecture.md)
R11's grep, whose whole value is being short.

**Amended.** It was introduced as a *signal, not a gate* — its own workflow on
`workflow_dispatch` and a nightly schedule, never on a pull request — on the grounds that a
provider's model update can turn it red with no change to this repository. That is now
reversed: it is a `test-eval` job in `ci.yml`, in the same parallel fan-out as the others.
The trade is deliberate. A prompt regression is caught at the commit that caused it rather
than at 03:17 the next morning, and the cost is a failure mode no other job has — CI red
with an innocent diff, plus real API spend on every push. The `eval-report` artifact is
what tells the two apart, so the job uploads it on success as well as on failure.

Nothing in it is named `*.test.ts`, and that is the whole mechanism: `run.ts`, `cases.ts`,
`askModel.ts` and `generate-content.ts` are plain modules, so neither Jest project's
`testMatch` can pick them up and R4's `find` has nothing to report. Naming them
`*.test.ts` would have swept them into a bucket that must never make a network call —
which is exactly what R4 exists to prevent, so the rule protects this bucket rather than
needing an exception for it.

`tests/eval/` is a second test composition root, alongside `tests/support/`: it names
`createGeminiClient` directly, which is why [ADR 0001](adr-0001-layered-architecture.md)
R11's command exempts it.

## Rules

| # | Subject | May import | Must not import |
|---|---|---|---|
| R1 | `apps/server/src/**/*.test.ts` | anything from `src/` | `pg`, `drizzle-orm` |
| R2 | `apps/server/src/**/*.test.ts` | `src/db/content.ts` and `src/db/content.generated.ts` (pure data) | `src/db/client.ts`, `db/migrate.ts`, `db/seed.ts`, `db/cli.ts` (`db/reseed.ts` opens no connection of its own — it takes a `Db` — so its absence here is deliberate, not an oversight) |
| R3 | `apps/server/src/**/*.test.ts` | `tests/support/fakes.ts`, `tests/support/testRng.ts` | `tests/support/testDb.ts`, `dbNames.ts`, `withTx.ts`, `globalSetup.ts`, `globalTeardown.ts` |
| R4 | `apps/server/tests/` | test files under `tests/integration/`; the eval bucket's plain modules under `tests/eval/` | a `*.test.ts` anywhere else under `tests/` |
| R5 | `apps/server/jest.config.js`'s `unit` project | `testMatch`, `restoreMocks`, `resetMocks`, `transformIgnorePatterns` | a `globalSetup` (or `globalTeardown`) key |

## Rules that are not import rules

- **R6 — `tests/support/` is the test composition root; database creation elsewhere
  in `tests/` is not automatically a violation.** `tests/integration/db/schema.test.ts`,
  `db/client.test.ts`, `repo/health.test.ts` and `support/isolation.test.ts` call
  `createDb`/`CREATE DATABASE` directly. That is legitimate: they test the harness and
  the database client themselves, not application code that should receive a database
  through composition. The boundary this ADR protects is `src/` (infra-free) versus
  `tests/` (infra-permitted), not "integration" versus "support" — R1-R4 are what make
  that boundary greppable; this bullet exists so the exception is not later mistaken
  for a gap in R1-R4. Enforced by review at the point a new file is added to
  `tests/integration/`.

## How to detect a violation

`npm run lint:arch` runs the seven commands below alongside the other ADRs';
`scripts/check-adr-0004-test-topology.sh` mirrors this block verbatim. Each command
must print nothing.

```bash
# R1 — unit tests must not import pg or drizzle-orm
grep -rnE "from 'pg'|from 'drizzle-orm" apps/server/src --include='*.test.ts'

# R2 — unit tests must not import a connection-opening module from src/db/
grep -rnE "from '[^']*db/(client|migrate|seed|cli)'" apps/server/src --include='*.test.ts'

# R3 — from tests/support/, a unit test may take only fakes.ts and testRng.ts
grep -rnE "from '[^']*tests/support/" apps/server/src --include='*.test.ts' \
  | grep -vE "tests/support/(fakes|testRng)'"

# R4 — no test file under apps/server/tests/ except beneath tests/integration/
find apps/server/tests -name '*.test.ts' | grep -v '^apps/server/tests/integration/'

# R5 — the unit Jest project declares no globalSetup
awk '/displayName: .unit./,/^    \},/' apps/server/jest.config.js \
  | grep -vE '^\s*(//|\*)' | grep -n "globalSetup"

# R4 — no Jest project may pick up an eval file
grep -n "eval" apps/server/jest.config.js

# R4 — nothing under tests/eval/ is imported by src/
grep -rn "tests/eval" apps/server/src --include='*.ts'
```

### What the rules cover

- Scans `apps/server/src/**/*.test.ts` (R1-R3), the shape of `apps/server/tests/` (R4),
  and `apps/server/jest.config.js` (R5).
- `packages/core` and `apps/mobile` follow the same folder-decides-the-bucket rule, but
  are not scanned by these commands: both are already entirely colocated and
  infrastructure-free today, so there is no split bucket there for R1-R5 to police.
- `e2e/` is deliberately out of scope. Playwright owns a long-lived `lang_tutor_e2e`
  database by design (`e2e/globalSetup.ts`) — a different strategy for a different
  kind of test, not a violation of this one.
- `tests/support/` is the test composition root, exactly as `composition.ts` is under
  [ADR 0001](adr-0001-layered-architecture.md) — it may create a database, open a pool,
  and hold `globalSetup`/`globalTeardown`, and R4 is what keeps it holding no test
  files of its own.

## Why

- CI's `test-unit` job having no database only catches a unit test that actually
  dials out; it does not catch one that imports `testDb` or `pg` and merely never
  connects. R1-R3 make that boundary greppable in seconds, instead of provable only
  by a full `npm ci` + Docker + integration run.
- R5 exists because a stray `globalSetup` on the `unit` project would attach Postgres
  setup at the config level, defeating R1-R3 without a single forbidden import
  appearing anywhere.

## Related

- [ADR 0001](adr-0001-layered-architecture.md)'s "What the rules cover" section
  grants `tests/support/` its composition-root carve-out; this ADR puts edges on
  that carve-out (R3-R4) rather than repeating it.
- [ADR 0002](adr-0002-di-with-closures.md) — orthogonal axis: this ADR does not
  change how a collaborator is constructed, only which folder a test that needs one
  is allowed to live in.
