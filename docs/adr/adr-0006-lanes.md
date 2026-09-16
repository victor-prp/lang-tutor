# ADR 0006: Every checkout is self-contained

- **Status:** Accepted
- **Date:** 2026-09-16
- **Source:** [phase 15 design](../superpowers/specs/2026-09-16-lang-tutor-phase-15-lanes-design.md)

## Decision

Nothing a checkout runs, starts or tests may read or write state another checkout could be
using at the same time. A checkout is a **lane**: a slot and a name, and from those one
script derives every port, database and namespace it will touch.

```
  .lane + branch          identity     slot 1..9, name = branch slug, [a-z0-9_], <= 24
        │
        ▼
  scripts/lane-env.sh     the formula  the ONLY file holding the arithmetic
        │                              exports PORT, DATABASE_URL, METRO_PORT,
        │                              E2E_*, TEST_DB_PREFIX, EXPO_PUBLIC_API_URL
        ├─────────────────────────────────────────────┐
        ▼                                             ▼
  package.json scripts    wiring       process.env    reading
  every start-or-test                  server, tests, e2e, mobile —
  script runs through it               defaults are lane 0's values
```

The main checkout is lane 0 and every value it sees is what this repo used before lanes
existed, which is why every default in code is lane 0's.

Postgres and MockServer are shared, deliberately: both are behaviour-free and namespaced
per caller, so they are the one kind of state a lane may reach. Compose is started only
from lane 0.

## Rules

| # | Subject | Must not appear |
|---|---|---|
| R1 | `e2e/`, `apps/server/tests/`, `scripts/`, root `package.json` | a literal port `3001`, `3002`, `8081` or `8082` |
| R2 | `e2e/`, `scripts/`, root `package.json` | a `lang_tutor` database name in a string literal or a URL path |
| R3 | root `package.json` scripts `server`, `mobile`, `e2e`, `test:integration`, `lane:list`, `lane:down`, `db:*`, `dict:*` | a script body that does not invoke `lane-env.sh` |
| R4 | `e2e/urls.ts`, `e2e/tests/support/mockServer.ts`; `scripts/*.sh` | an address or namespace that is not read from the environment; an absolute path under `/tmp` that is not from `mktemp` |

The owners, excluded from R1 and R2, are `scripts/lane-env.sh` (the formula),
`scripts/test-lane-env.sh` (which asserts the numbers it produces), this ADR's own check
script (which carries them in its pattern), and `apps/server/src/config.ts` (lane 0's
defaults, which ADR 0002 puts in a composition root and which is outside R1's subject
anyway).

R2 does not cover `apps/server/tests/`: `tests/integration/db/lanes.test.ts` and
`ensureDatabase.test.ts` name databases because naming them is their subject.

## Rules that are not import rules

- **R5 — Any new shared resource is derived from the lane.** A port, a database, a
  MockServer namespace, a fixed path outside the checkout, a browser profile, a lock file,
  a build cache. R1, R2 and R4 catch the forms that exist in this repo today; a new form is
  not greppable in advance, and this rule is what a reviewer applies when a change
  introduces one.

  The build cache is in that list because it caught us. `expo/metro-config` puts Metro's
  transform cache in `os.tmpdir()/metro-cache` — one directory shared by every checkout on
  the machine — and Metro's cache key does not include the `EXPO_PUBLIC_*` values the Expo
  babel transform inlines. An `expo export` in a phase-15 worktree, with
  `EXPO_PUBLIC_API_URL` explicitly set to that lane's port, produced a bundle containing
  `requireEnvValue("http://localhost:3101", 'EXPO_PUBLIC_API_URL')` — nightly QA's port,
  inlined by a different checkout's export. The app then called the wrong server, and every
  e2e test that drove the UI failed with a timeout that said nothing about why.
  `apps/mobile/metro.config.js` now keys the cache on those values. Nothing greps for this
  class of bug; only R5 catches it.

- **R6 — The main checkout stays on `master` and is lane 0; feature work happens in
  worktrees.** No script checks this, and none can: a checkout's branch is legitimately
  whatever its owner needs. It is written down because the design rests on it — a feature
  branch held in the main checkout cannot also be checked out in a worktree, and switching
  branches under a running server and Metro is what lanes exist to avoid.
- **R7 — `nightly-qa/` is deliberately outside the formula.** Its ports (3101, 8092) are
  hand-picked and unreachable by the arithmetic. In CI each run owns its runner, so lanes
  buy it nothing; locally its reserved ports already coexist with a dev loop.

## How to detect a violation

```bash
# R1 — a lane-0 port literal outside the owners.
# -w rather than an explicit (^|[^0-9]) guard: BSD grep does not support an empty
# left alternative, so that form silently matches NOTHING on macOS — a check that
# cannot fire, which is indistinguishable from one that passes.
grep -rnwE "(3001|3002|8081|8082)" \
  e2e apps/server/tests scripts package.json \
  --include='*.ts' --include='*.sh' --include='*.json' \
  | grep -vE '^(scripts/lane-env\.sh|scripts/test-lane-env\.sh|scripts/check-adr-0006-lanes\.sh):'

# R2 — a lane-0 database name in a string literal or a URL path
grep -rnE "['\"\`/]lang_tutor" e2e scripts package.json \
  --include='*.ts' --include='*.sh' --include='*.json' \
  | grep -vE '^(scripts/lane-env\.sh|scripts/test-lane-env\.sh|scripts/check-adr-0006-lanes\.sh):'

# R3 — a start-or-test script that bypasses the wrapper
for key in server mobile e2e test:integration db:up db:migrate db:reseed \
           dict:export dict:restore lane:list lane:down; do
  line=$(grep -E "^    \"$key\": " package.json)
  printf '%s' "$line" | grep -q 'lane-env.sh' || echo "$line"
done

# R4 — an address or namespace not read from the environment, or a hardcoded temp path
grep -nE '^export const (API_URL|APP_URL|MOCKSERVER_URL) =' e2e/urls.ts | grep -v requireEnv
grep -n 'E2E_MOCK_NAMESPACE = ' e2e/tests/support/mockServer.ts | grep -v requireEnv
grep -rn '/tmp/' scripts --include='*.sh' | grep -v 'mktemp'
```
