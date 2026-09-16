# Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every checkout of this repo able to run its own server, app, integration suite and e2e suite at the same time as every other checkout, with no coordination and no possibility of reaching another checkout's state.

**Architecture:** One shell script, `scripts/lane-env.sh`, derives every port, database name and namespace from a checkout's slot (a `.lane` file) and branch, and exports them before exec'ing the command it wraps. Every root npm script that starts or tests something runs through it. Node code reads `process.env` and nothing else changes shape, which keeps ADR 0001's composition roots the only readers of the environment. The main checkout is lane 0 and every value it sees is unchanged.

**Tech Stack:** Bash, Node 26 + tsx, Hono, Drizzle ORM, Postgres 17, Jest 29, Playwright, Expo.

**Spec:** `docs/superpowers/specs/2026-09-16-lang-tutor-phase-15-lanes-design.md`

## Global Constraints

- **Lane 0 is unchanged.** Ports 3001 / 8081 / 8082, databases `lang_tutor` / `lang_tutor_e2e`, test prefix `t_`. Every default in code is lane 0's value, so an unset environment behaves exactly as today.
- **The formula lives in exactly one file:** `scripts/lane-env.sh`. The only other place a lane-0 literal may appear is `apps/server/src/config.ts` (a composition root's defaults, ADR 0002).
- **Lane names are `[a-z0-9_]`, at most 24 characters.** Longer branch slugs are cut to 17 characters plus `_` plus 6 hex characters of the branch's SHA-1.
- **Slots are 1..9.** Lane 0 is the main checkout. A tenth worktree is refused.
- **Port formula:** server `3001 + 1000·slot`, e2e API `3002 + 1000·slot`, Metro `8081 + 1000·slot`, e2e app `8082 + 1000·slot`.
- **Database names:** dev `lang_tutor_<name>`, e2e `lang_tutor_e2e_<name>`, test prefix `t_<name>_`. Lane 0 keeps the bare names.
- **Postgres identifiers are 63 bytes.** Every derived name must fit; `testDbName` computes its slug budget from the prefix length rather than a constant.
- **Docker is shared and untouched.** One Postgres, one MockServer, one compose project, started only from lane 0.
- **`nightly-qa/` is out of scope** and must not be modified by any task. Its ports 3101 and 8092 are unreachable by the formula.
- **Every ADR check rule is proved by planting a violation first** (CLAUDE.md). A check that prints nothing is indistinguishable from a check that cannot fire.
- **Commit after every task.** Never commit to `master`; this work happens on `phase-15-lanes`.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `scripts/lane-env.sh` | The formula. Derives and exports every lane value; allocates slots. The only file that may contain the arithmetic. |
| `scripts/test-lane-env.sh` | Tests the formula against a throwaway git repository with real worktrees. No database. |
| `scripts/db-up.sh` | `docker compose up` plus the guard that refuses to start a second Postgres from a non-zero lane. |
| `apps/server/src/db/ensureDatabase.ts` | Creates the lane's database when absent and stamps it with a `COMMENT ON DATABASE`. |
| `apps/server/src/db/lanes.ts` | The two catalogue queries: list lane databases, drop one lane's databases. Pure SQL, no process I/O. |
| `docs/adr/adr-0006-lanes.md` | The invariant and its rules. |
| `scripts/check-adr-0006-lanes.sh` | Those rules as commands. |

**Modified:**

| Path | Change |
|---|---|
| `apps/server/src/config.ts` | `lane` on `Config`; `databaseNameFrom`, `maintenanceUrlFor`, `assertDatabaseIdentifier`. |
| `apps/server/src/composition.ts` | `identity` on `AppDeps`, passed through `createServerDeps`. |
| `apps/server/src/app.ts` | `/health` returns the identity. |
| `apps/server/src/index.ts` | Builds the identity from config and passes it in. |
| `apps/server/src/db/cli.ts` | Ensures the database exists; `--lane-list` and `--lane-down`. |
| `packages/core/src/api/schemas.ts` | `HealthResponseSchema` gains `lane`, `database`, `port`. |
| `apps/server/tests/support/dbNames.ts` | Reads `TEST_DB_PREFIX`. |
| `apps/server/tests/support/globalSetup.ts` | Sweeps by the lane's prefix only. |
| `apps/server/tests/support/fakes.ts`, `serverDeps.ts` | Supply `identity`. |
| `e2e/urls.ts`, `e2e/globalSetup.ts`, `e2e/playwright.config.ts`, `e2e/tests/support/mockServer.ts` | Read the lane's values from the environment. |
| `apps/mobile/package.json` | `start` and `serve:web` take their ports from the environment. |
| `package.json` | Every start/test script wrapped; `lane:list`, `lane:down`, `test:lanes` added. |
| `scripts/setup-worktree.sh` | Allocates the slot, generates `.env.local`, provisions the database. |
| `.gitignore` | `.lane`. |
| `.claude/settings.json` | SessionStart reports the lane. |
| `.github/workflows/ci.yml` | Runs `test:lanes`; runs integration with a CI prefix. |
| `README.md`, `CLAUDE.md` | A "Working in lanes" section; the Worktrees section rewritten. |

---

### Task 1: The formula and its tests

`scripts/lane-env.sh` is the whole mechanism. Nothing else can be built until it exists, and it is tested first because every later task trusts its output.

**Files:**
- Create: `scripts/lane-env.sh`
- Create: `scripts/test-lane-env.sh`
- Modify: `package.json` (add `test:lanes`)
- Modify: `.gitignore` (add `.lane`)
- Modify: `.github/workflows/ci.yml` (run `test:lanes` in the `check-adrs` job)

**Interfaces:**
- Consumes: nothing.
- Produces: `scripts/lane-env.sh` with three modes — no arguments prints `KEY=value` lines; `--export` prints shell-quoted `KEY='value'` lines for `eval`; `--allocate` writes `.lane` and prints the slot; any other arguments are exec'd with the environment exported. Exported names: `LANE`, `LANE_SLOT`, `LANE_ROOT`, `LANE_BRANCH`, `PORT`, `METRO_PORT`, `DATABASE_URL`, `E2E_API_URL`, `E2E_APP_URL`, `E2E_APP_PORT`, `E2E_DATABASE_URL`, `E2E_MOCK_NAMESPACE`, `TEST_DB_PREFIX`, `EXPO_PUBLIC_API_URL`.

- [ ] **Step 1: Write the failing test script**

Create `scripts/test-lane-env.sh`:

```bash
#!/usr/bin/env bash
#
# Tests scripts/lane-env.sh against a throwaway git repository with real
# worktrees. No database, no Docker, no npm install — the formula is pure text,
# and this is what lets CI run it in the dependency-free check-adrs job.
#
# The fixture repo gets a copy of scripts/ committed to it, so `git worktree
# add` brings lane-env.sh along exactly as it does in the real repo, and every
# invocation roots itself the same way production does (dirname "$0"/..).

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

status=0
checks=0

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  checks=$((checks + 1))
  if [ "$expected" = "$actual" ]; then
    printf '  ok         %s\n' "$label"
  else
    printf '\n  FAIL       %s\n             expected: %s\n             actual:   %s\n' \
      "$label" "$expected" "$actual" >&2
    status=1
  fi
}

expect_fails() {
  local label="$1"; shift
  checks=$((checks + 1))
  if "$@" > /dev/null 2>&1; then
    printf '\n  FAIL       %s (the command succeeded; it must not)\n' "$label" >&2
    status=1
  else
    printf '  ok         %s\n' "$label"
  fi
}

# `lane-env.sh` with no arguments prints KEY=value; this pulls one out.
value_of() {
  local dir="$1" key="$2"
  (cd "$dir" && bash ./scripts/lane-env.sh 2>/dev/null) | sed -n "s/^$key=//p"
}

# --- the fixture -------------------------------------------------------------
MAIN="$FIXTURE/main"
mkdir -p "$MAIN"
git init -q -b master "$MAIN"
mkdir -p "$MAIN/scripts" "$MAIN/apps/mobile"
cp "$REPO/scripts/lane-env.sh" "$MAIN/scripts/lane-env.sh"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -qm init

worktree() { # worktree <dir-name> <branch>
  git -C "$MAIN" worktree add -q -b "$2" "$FIXTURE/$1" master 2>/dev/null
  (cd "$FIXTURE/$1" && bash ./scripts/lane-env.sh --allocate > /dev/null)
}

echo "Testing scripts/lane-env.sh"
echo

# --- lane 0 ------------------------------------------------------------------
expect_eq "main checkout is lane main"            "main"       "$(value_of "$MAIN" LANE)"
expect_eq "main checkout is slot 0"               "0"          "$(value_of "$MAIN" LANE_SLOT)"
expect_eq "main checkout serves on 3001"          "3001"       "$(value_of "$MAIN" PORT)"
expect_eq "main checkout runs Metro on 8081"      "8081"       "$(value_of "$MAIN" METRO_PORT)"
expect_eq "main checkout e2e app is 8082"         "8082"       "$(value_of "$MAIN" E2E_APP_PORT)"
expect_eq "main checkout uses lang_tutor" \
  "postgres://postgres:postgres@localhost:5432/lang_tutor" "$(value_of "$MAIN" DATABASE_URL)"
expect_eq "main checkout e2e database" \
  "postgres://postgres:postgres@localhost:5432/lang_tutor_e2e" "$(value_of "$MAIN" E2E_DATABASE_URL)"
expect_eq "main checkout test prefix is bare"     "t_"         "$(value_of "$MAIN" TEST_DB_PREFIX)"
expect_eq "main checkout mock namespace"          "e2e"        "$(value_of "$MAIN" E2E_MOCK_NAMESPACE)"
expect_eq "MockServer is shared, not per lane" \
  "http://localhost:1080"                                      "$(value_of "$MAIN" MOCKSERVER_URL)"

# --- the first worktree ------------------------------------------------------
worktree wt1 feature
expect_eq "first worktree takes slot 1"           "1"          "$(value_of "$FIXTURE/wt1" LANE_SLOT)"
expect_eq "lane is named after the branch"        "feature"    "$(value_of "$FIXTURE/wt1" LANE)"
expect_eq "slot 1 serves on 4001"                 "4001"       "$(value_of "$FIXTURE/wt1" PORT)"
expect_eq "slot 1 runs Metro on 9081"             "9081"       "$(value_of "$FIXTURE/wt1" METRO_PORT)"
expect_eq "slot 1 e2e api is 4002" \
  "http://localhost:4002"                                      "$(value_of "$FIXTURE/wt1" E2E_API_URL)"
expect_eq "slot 1 e2e app is 9082" \
  "http://localhost:9082"                                      "$(value_of "$FIXTURE/wt1" E2E_APP_URL)"
expect_eq "slot 1 dev database" \
  "postgres://postgres:postgres@localhost:5432/lang_tutor_feature" \
  "$(value_of "$FIXTURE/wt1" DATABASE_URL)"
expect_eq "slot 1 e2e database" \
  "postgres://postgres:postgres@localhost:5432/lang_tutor_e2e_feature" \
  "$(value_of "$FIXTURE/wt1" E2E_DATABASE_URL)"
expect_eq "slot 1 test prefix"                    "t_feature_" "$(value_of "$FIXTURE/wt1" TEST_DB_PREFIX)"
expect_eq "slot 1 mock namespace"                 "e2e_feature" "$(value_of "$FIXTURE/wt1" E2E_MOCK_NAMESPACE)"
expect_eq "the app targets this lane's server" \
  "http://localhost:4001"                                      "$(value_of "$FIXTURE/wt1" EXPO_PUBLIC_API_URL)"

# --- allocation --------------------------------------------------------------
worktree wt2 second
expect_eq "the second worktree takes slot 2"      "2"          "$(value_of "$FIXTURE/wt2" LANE_SLOT)"
expect_eq "allocation is idempotent"              "2"          \
  "$(cd "$FIXTURE/wt2" && bash ./scripts/lane-env.sh --allocate)"

# A freed slot is reused: remove wt1 and the next worktree takes 1, not 3.
git -C "$MAIN" worktree remove --force "$FIXTURE/wt1"
worktree wt3 third
expect_eq "a freed slot is reused"                "1"          "$(value_of "$FIXTURE/wt3" LANE_SLOT)"

# --- names -------------------------------------------------------------------
worktree wt4 feature/a-very-long-branch-name-that-will-not-fit
long=$(value_of "$FIXTURE/wt4" LANE)
expect_eq "a long branch name is cut to 24"       "24"         "${#long}"
expect_eq "a long name keeps a readable head"     "feature_a_very_lo" "${long%_*}"
expect_eq "a long name ends in 6 hex" "yes" \
  "$(printf '%s' "$long" | grep -qE '_[0-9a-f]{6}$' && echo yes || echo no)"

worktree wt5 Feature/UPPER.and.dots
expect_eq "a name is slugged to [a-z0-9_]"        "feature_upper_and_dots" \
  "$(value_of "$FIXTURE/wt5" LANE)"

# --- refusals ----------------------------------------------------------------
git -C "$MAIN" worktree add -q --detach "$FIXTURE/wt6" master
expect_fails "a detached HEAD is refused" \
  env -C "$FIXTURE/wt6" bash ./scripts/lane-env.sh

worktree wt7 tmpl
expect_fails "the reserved name tmpl is refused" \
  env -C "$FIXTURE/wt7" bash ./scripts/lane-env.sh

worktree wt8 test
expect_fails "the reserved name test is refused" \
  env -C "$FIXTURE/wt8" bash ./scripts/lane-env.sh

# Fill every remaining slot, then ask for one more. Six are taken at this point
# — wt2, wt3, wt4, wt5, wt7, wt8 — so three fills reach the cap of nine.
for n in 9 10 11; do worktree "wtfill$n" "fill$n"; done
git -C "$MAIN" worktree add -q -b overflow "$FIXTURE/wt_over" master
expect_fails "a tenth lane is refused" \
  env -C "$FIXTURE/wt_over" bash ./scripts/lane-env.sh --allocate

# --- the environment wins ----------------------------------------------------
expect_eq "a preset PORT is left alone"           "9999"       \
  "$(cd "$FIXTURE/wt3" && PORT=9999 bash ./scripts/lane-env.sh | sed -n 's/^PORT=//p')"
expect_eq "a preset DATABASE_URL is left alone"   "postgres://elsewhere/db" \
  "$(cd "$FIXTURE/wt3" && DATABASE_URL=postgres://elsewhere/db bash ./scripts/lane-env.sh \
     | sed -n 's/^DATABASE_URL=//p')"
expect_eq "LANE_API_HOST reaches the app url"     "http://192.168.1.50:4001" \
  "$(cd "$FIXTURE/wt3" && LANE_API_HOST=192.168.1.50 bash ./scripts/lane-env.sh \
     | sed -n 's/^EXPO_PUBLIC_API_URL=//p')"

# --- exec and export modes ---------------------------------------------------
expect_eq "it execs the command it wraps with the lane exported" "4001" \
  "$(cd "$FIXTURE/wt3" && bash ./scripts/lane-env.sh sh -c 'printf %s "$PORT"')"
expect_eq "--export is safe to eval" "4001" \
  "$(cd "$FIXTURE/wt3" && eval "$(bash ./scripts/lane-env.sh --export)" && printf %s "$PORT")"

echo
if [ "$status" -ne 0 ]; then
  echo "lane-env.sh FAILED ($checks checks)" >&2
else
  echo "lane-env.sh ok ($checks checks)"
fi
exit "$status"
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bash scripts/test-lane-env.sh
```

Expected: fails immediately — `cp: scripts/lane-env.sh: No such file or directory`, then every check reporting an empty actual value.

- [ ] **Step 3: Write `scripts/lane-env.sh`**

```bash
#!/usr/bin/env bash
#
# The lane formula, and the only place it lives.
#
# A "lane" is a checkout together with everything it needs to run alone: ports,
# databases, a MockServer namespace, a test-database prefix. The main checkout
# is lane 0 and every value below is what it has always used, so an unset
# environment behaves exactly as this repo did before lanes existed.
#
# Three modes:
#   lane-env.sh                 print KEY=value lines (the hook and humans read this)
#   lane-env.sh --export        print KEY='value' lines, safe to eval
#   lane-env.sh --allocate      claim the lowest free slot, write .lane, print it
#   lane-env.sh <command...>    export everything and exec the command
#
# Anything already set in the environment WINS over the derived value. That is
# what keeps CI, nightly-qa/ and a one-off override working without knowing this
# file exists.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT" || exit 1

fail() { echo "lane-env.sh: $1" >&2; exit 1; }

# --- which checkout is this? -------------------------------------------------
# The main checkout is the one whose --git-common-dir resolves to itself. This
# is the same test setup-worktree.sh uses, and it is true whatever branch the
# main checkout happens to hold.
MAIN=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd -P) \
  || fail "not a git repository"
IS_MAIN=0
[ "$ROOT" = "$MAIN" ] && IS_MAIN=1

MAX_SLOT=9

# --- slots -------------------------------------------------------------------
# Every worktree's .lane file, read through `git worktree list` so this works
# from any checkout and never guesses at directory layout.
claimed_slots() {
  git worktree list --porcelain \
    | sed -n 's/^worktree //p' \
    | while IFS= read -r dir; do
        [ "$dir" = "$MAIN" ] && continue
        [ "$dir" = "$ROOT" ] && continue
        [ -f "$dir/.lane" ] && cat "$dir/.lane"
      done
}

allocate_slot() {
  [ "$IS_MAIN" -eq 1 ] && fail "the main checkout is lane 0; it needs no .lane file"
  if [ -f .lane ]; then
    cat .lane
    return 0
  fi
  local taken slot
  taken=$(claimed_slots)
  for slot in $(seq 1 "$MAX_SLOT"); do
    if ! printf '%s\n' "$taken" | grep -qx "$slot"; then
      printf '%s\n' "$slot" > .lane
      printf '%s\n' "$slot"
      return 0
    fi
  done
  fail "all $MAX_SLOT lanes are in use. Free one with 'npm run lane:down' and 'git worktree remove'."
}

# Handled before the derivation below, and it has to be: a fresh worktree has no
# .lane file yet, which is precisely what the derivation refuses to run without.
if [ "${1:-}" = "--allocate" ]; then
  allocate_slot
  exit 0
fi

# --- the name ----------------------------------------------------------------
# [a-z0-9_] only, so every identifier derived from it is a legal Postgres
# identifier that needs no quoting, and every character is one byte — which is
# what makes the 24-character cap a byte budget as well.
slug_of() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/_/g' \
    | sed -E 's/^_+//; s/_+$//'
}

lane_name_of() {
  local branch="$1" slug hash
  slug=$(slug_of "$branch")
  [ -n "$slug" ] || fail "branch '$branch' slugs to nothing"
  if [ "${#slug}" -gt 24 ]; then
    # 17 + '_' + 6 = 24. The hash is of the FULL branch name, so two branches
    # sharing a 17-character head still get different lanes.
    hash=$(printf '%s' "$branch" | shasum | cut -c1-6)
    slug=$(printf '%s' "$slug" | cut -c1-17 | sed -E 's/_+$//')_$hash
  fi
  printf '%s' "$slug"
}

# --- derive ------------------------------------------------------------------
if [ "$IS_MAIN" -eq 1 ]; then
  LANE_SLOT=0
  LANE=main
  LANE_BRANCH=$(git branch --show-current)
else
  [ -f .lane ] || fail "no .lane file here. Run ./scripts/setup-worktree.sh first."
  LANE_SLOT=$(tr -d '[:space:]' < .lane)
  case "$LANE_SLOT" in
    ''|*[!0-9]*) fail ".lane does not contain a number" ;;
  esac
  [ "$LANE_SLOT" -ge 1 ] && [ "$LANE_SLOT" -le "$MAX_SLOT" ] \
    || fail ".lane holds $LANE_SLOT, which is outside 1..$MAX_SLOT"
  LANE_BRANCH=$(git branch --show-current)
  [ -n "$LANE_BRANCH" ] || fail "HEAD is detached; a lane takes its name from a branch"
  LANE=$(lane_name_of "$LANE_BRANCH")
  # `t_test_` and `t_tmpl_` are lane 0's own test-database prefixes; a lane
  # named test or tmpl would make its databases indistinguishable from them,
  # and lane 0's sweep would drop them.
  case "$LANE" in
    test|tmpl) fail "'$LANE' is reserved; rename the branch" ;;
  esac
fi

PG_HOST="${PGHOST:-localhost}"
PG_PORT="${PGPORT:-5432}"
pg_url() { printf 'postgres://postgres:postgres@%s:%s/%s' "$PG_HOST" "$PG_PORT" "$1"; }

if [ "$LANE_SLOT" -eq 0 ]; then
  d_db=lang_tutor
  d_e2e_db=lang_tutor_e2e
  d_prefix=t_
  d_ns=e2e
else
  d_db="lang_tutor_$LANE"
  d_e2e_db="lang_tutor_e2e_$LANE"
  d_prefix="t_${LANE}_"
  d_ns="e2e_$LANE"
fi

# A thousand per lane: easy to hold in your head, and no slot can reach
# nightly-qa's reserved 3101 and 8092.
d_port=$((3001 + 1000 * LANE_SLOT))
d_e2e_api_port=$((3002 + 1000 * LANE_SLOT))
d_metro_port=$((8081 + 1000 * LANE_SLOT))
d_e2e_app_port=$((8082 + 1000 * LANE_SLOT))

# The host a phone or simulator uses to reach this lane's server. Taken from the
# main checkout's .env.local so a LAN IP set once serves every lane; the port is
# always this lane's own.
api_host() {
  [ -n "${LANE_API_HOST:-}" ] && { printf '%s' "$LANE_API_HOST"; return; }
  local from_main
  from_main=$(sed -n 's#^EXPO_PUBLIC_API_URL=http://\([^:/]*\).*#\1#p' \
    "$MAIN/apps/mobile/.env.local" 2>/dev/null | head -1)
  printf '%s' "${from_main:-localhost}"
}
HOST=$(api_host)

LANE_ROOT="$ROOT"
PORT="${PORT:-$d_port}"
METRO_PORT="${METRO_PORT:-$d_metro_port}"
E2E_APP_PORT="${E2E_APP_PORT:-$d_e2e_app_port}"
DATABASE_URL="${DATABASE_URL:-$(pg_url "$d_db")}"
E2E_DATABASE_URL="${E2E_DATABASE_URL:-$(pg_url "$d_e2e_db")}"
E2E_API_URL="${E2E_API_URL:-http://localhost:$d_e2e_api_port}"
E2E_APP_URL="${E2E_APP_URL:-http://localhost:$E2E_APP_PORT}"
E2E_MOCK_NAMESPACE="${E2E_MOCK_NAMESPACE:-$d_ns}"
TEST_DB_PREFIX="${TEST_DB_PREFIX:-$d_prefix}"
EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-http://$HOST:$PORT}"
# Shared by every lane and not derived from the slot — one container, namespaced
# per caller. It is here because this file is where an address is allowed to be
# written down, not because it varies.
MOCKSERVER_URL="${MOCKSERVER_URL:-http://localhost:1080}"

KEYS="LANE LANE_SLOT LANE_ROOT LANE_BRANCH PORT METRO_PORT DATABASE_URL \
E2E_API_URL E2E_APP_URL E2E_APP_PORT E2E_DATABASE_URL E2E_MOCK_NAMESPACE \
MOCKSERVER_URL TEST_DB_PREFIX EXPO_PUBLIC_API_URL"

case "${1:-}" in
  '')
    for key in $KEYS; do eval "printf '%s=%s\n' \"\$key\" \"\$$key\""; done
    ;;
  --export)
    # Single-quoted, with embedded quotes escaped the POSIX way, so a worktree
    # path containing a space survives `eval`.
    for key in $KEYS; do
      eval "value=\$$key"
      printf "export %s='%s'\n" "$key" "$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
    done
    ;;
  *)
    # shellcheck disable=SC2086
    export $KEYS
    exec "$@"
    ;;
esac
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
bash scripts/test-lane-env.sh
```

Expected: every check `ok`, final line `lane-env.sh ok (N checks)`, exit 0.

- [ ] **Step 5: Wire it into npm and CI, and ignore `.lane`**

In `package.json`, add to `scripts`:

```json
    "test:lanes": "bash scripts/test-lane-env.sh",
```

In `.gitignore`, add after `.claude/worktrees/`:

```
.lane
```

In `.github/workflows/ci.yml`, in the `check-adrs` job, add a step after the existing `./scripts/check-adrs.sh` run:

```yaml
      # The lane formula is pure text — no dependencies, no database — so it
      # belongs in the one job that needs no setup step.
      - run: ./scripts/test-lane-env.sh
```

- [ ] **Step 6: Verify the wiring and commit**

```bash
npm run test:lanes
git add scripts/lane-env.sh scripts/test-lane-env.sh package.json .gitignore .github/workflows/ci.yml
git commit -m "feat: derive every lane's ports and database names from one script

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Config understands its database URL and its lane

Three pure functions and one new `Config` field. Everything later — the health identity, creating a missing database, the lane catalogue — reads the database name through this one place.

**Files:**
- Modify: `apps/server/src/config.ts`
- Test: `apps/server/src/config.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; `LANE` is the variable Task 1 exports.
- Produces:
  - `Config` gains `lane: string` (default `'main'`).
  - `databaseNameFrom(databaseUrl: string): string`
  - `maintenanceUrlFor(databaseUrl: string): string`
  - `assertDatabaseIdentifier(name: string): void` — throws unless `/^[a-z][a-z0-9_]{0,62}$/`.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/config.test.ts`, change the import line to:

```ts
import {
  assertDatabaseIdentifier,
  databaseNameFrom,
  loadConfig,
  loadGeminiConfig,
  maintenanceUrlFor,
} from './config';
```

Add `lane: 'main'` to the expected object in `falls back to the development defaults for an empty environment`, and add `lane: 'other-lane'`/`LANE: 'other-lane'` to the `takes every value from the environment` case. Then append:

```ts
describe('the lane', () => {
  it('is main when LANE is unset, empty or blank', () => {
    expect(loadConfig({}).lane).toBe('main');
    expect(loadConfig({ LANE: '' }).lane).toBe('main');
    expect(loadConfig({ LANE: '   ' }).lane).toBe('main');
  });

  it('is whatever LANE says, trimmed', () => {
    expect(loadConfig({ LANE: ' phase_15 ' }).lane).toBe('phase_15');
  });
});

// Two functions rather than one regex at each call site: /health reports the
// name, and creating a missing database needs the maintenance URL. Both are
// readings of DATABASE_URL, which is what this module is for.
describe('databaseNameFrom', () => {
  it('takes the name out of a connection string', () => {
    expect(databaseNameFrom('postgres://postgres:postgres@localhost:5432/lang_tutor')).toBe(
      'lang_tutor',
    );
  });

  it('is not confused by a query string or a percent-encoded name', () => {
    expect(databaseNameFrom('postgres://u:p@h:5432/lang_tutor_x?sslmode=disable')).toBe(
      'lang_tutor_x',
    );
    expect(databaseNameFrom('postgres://u:p@h:5432/a%20b')).toBe('a b');
  });
});

describe('maintenanceUrlFor', () => {
  it('points the same credentials and host at the postgres database', () => {
    expect(maintenanceUrlFor('postgres://postgres:postgres@localhost:5432/lang_tutor_x')).toBe(
      'postgres://postgres:postgres@localhost:5432/postgres',
    );
  });
});

// CREATE DATABASE cannot take a bound parameter, so the name is interpolated.
// Every name reaching that path comes from lane-env.sh, which emits [a-z0-9_];
// anything else is a bug in the formula and must not reach Postgres.
describe('assertDatabaseIdentifier', () => {
  it('accepts a lane database name', () => {
    expect(() => assertDatabaseIdentifier('lang_tutor_phase_15')).not.toThrow();
  });

  it('refuses anything that is not a bare lowercase identifier', () => {
    for (const bad of ['', 'Lang', '1lane', 'a-b', 'a b', 'a";drop', 'a'.repeat(64)]) {
      expect(() => assertDatabaseIdentifier(bad)).toThrow('database identifier');
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -w apps/server -- --testPathPattern config
```

Expected: FAIL — `databaseNameFrom is not a function`, and the two `loadConfig` expectations reporting a missing `lane`.

- [ ] **Step 3: Implement**

In `apps/server/src/config.ts`, add `lane: string;` to the `Config` type (after `databaseUrl`), add to the object `loadConfig` returns:

```ts
    // Which checkout this server belongs to. `main` is the main checkout, and
    // the default, so an unset environment is lane 0 — see scripts/lane-env.sh.
    lane: env.LANE?.trim() || 'main',
```

and append to the file:

```ts
/**
 * The database name inside a connection string. `/health` publishes it and the
 * lane tooling drops by it, so it is parsed once, here, rather than with a
 * regex at each call site.
 */
export function databaseNameFrom(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
}

/**
 * The same server, same credentials, pointed at the maintenance database.
 * CREATE DATABASE and DROP DATABASE cannot run from inside their target.
 */
export function maintenanceUrlFor(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/**
 * Throws unless `name` is a bare lowercase Postgres identifier.
 *
 * An identifier cannot be a bound parameter, so any CREATE/DROP DATABASE has to
 * interpolate it. Every name that reaches one comes from scripts/lane-env.sh,
 * which emits `[a-z0-9_]` only; this is the assertion that says so out loud
 * rather than trusting it.
 */
export function assertDatabaseIdentifier(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`refusing ${JSON.stringify(name)} as a database identifier`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w apps/server -- --testPathPattern config
npm run typecheck
```

Expected: config tests PASS. `typecheck` fails in `index.ts`/`cli.ts` only if they destructure `Config` exhaustively — they do not, so it should pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/config.test.ts
git commit -m "feat: config reads its lane and understands its database url

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `/health` says which lane answered

The trap this phase exists to close: today a healthy port proves nothing, because a second server that failed to bind leaves the first one answering. After this task every probe names the lane, the database and the port it reached.

**Files:**
- Modify: `packages/core/src/api/schemas.ts`
- Modify: `apps/server/src/composition.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/tests/support/fakes.ts`
- Modify: `apps/server/tests/support/serverDeps.ts`
- Test: `apps/server/src/app.test.ts`, `apps/server/src/openapi.test.ts`

**Interfaces:**
- Consumes: `Config.lane`, `databaseNameFrom` (Task 2).
- Produces:
  - `type ServerIdentity = { lane: string; database: string; port: number }` exported from `composition.ts`.
  - `AppDeps` gains `identity: ServerIdentity`.
  - `createServerDeps(io)` gains a required `identity: ServerIdentity` field.
  - `HealthResponse` becomes `{ ok, lane, database, port }`.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/app.test.ts`, replace `depsWithPing` and the `GET /health` block:

```ts
function depsWithPing(ok: boolean): AppDeps {
  return {
    sessions: unreachableSessions,
    users: unreachableUsers,
    translations: unreachableTranslations,
    health: { ping: async () => ok },
    identity: { lane: 'phase_15', database: 'lang_tutor_phase_15', port: 4001 },
    logger: createFakeLogger(),
  };
}

// No database: the health route's two branches are both reachable with a fake.
// The app's one database-backed case lives in tests/integration/app.test.ts.
describe('GET /health', () => {
  it('returns 200 and names the lane that answered when the check passes', async () => {
    const res = await createApp(depsWithPing(true)).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      lane: 'phase_15',
      database: 'lang_tutor_phase_15',
      port: 4001,
    });
  });

  // The identity is on the failure body too, and deliberately: a 503 from the
  // wrong lane is exactly as misleading as a 200 from it, and this is the body
  // a developer reads while wondering which server they reached.
  it('returns 503 and still names the lane when the check fails', async () => {
    const res = await createApp(depsWithPing(false)).request('/health');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      lane: 'phase_15',
      database: 'lang_tutor_phase_15',
      port: 4001,
    });
  });
});
```

In `apps/server/src/openapi.test.ts`, append:

```ts
describe('GET /health in the published document', () => {
  it('publishes the identity fields a caller needs to tell two lanes apart', async () => {
    const doc = await openApiDocument();
    const schema = doc.paths['/health'].get.responses['200'].content['application/json'].schema;
    expect(schema.required.sort()).toEqual(['database', 'lane', 'ok', 'port']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -w apps/server -- --testPathPattern 'app.test|openapi'
```

Expected: FAIL — the app tests report a body of `{ ok: true }` against the four-field expectation, and the document test reports `required` as `['ok']`.

- [ ] **Step 3: Implement**

In `packages/core/src/api/schemas.ts`, replace `HealthResponseSchema`:

```ts
// /health is part of the wire contract too: the e2e suite waits on it, and a
// 503 there is what distinguishes "server booting" from "broken". Since phase
// 15 it also answers "which server is this?" — several checkouts run at once,
// each on its own port and database, and a healthy port alone cannot tell them
// apart. The database is named, never the URL: the URL carries credentials.
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  lane: z.string(),
  database: z.string(),
  port: z.number().int(),
});
```

In `apps/server/src/composition.ts`, add above `AppDeps`:

```ts
/**
 * Which checkout this process belongs to, as published by /health. Data, not a
 * collaborator: app.ts holds no logic, so the values arrive already resolved
 * from the composition root that read the environment.
 */
export type ServerIdentity = {
  lane: string;
  database: string;
  port: number;
};
```

Add `identity: ServerIdentity;` to `AppDeps`, add `identity: ServerIdentity;` to the `io` parameter of `createServerDeps`, and add `identity: io.identity,` to the object it returns.

In `apps/server/src/app.ts`, replace the health handler:

```ts
  app.openapi(healthRoute, async (c) => {
    const ok = await deps.health.ping();
    // The identity is on both bodies: a 503 from the wrong lane misleads exactly
    // as much as a 200 from it.
    const body = { ...deps.identity, ok };
    return ok ? c.json(body, 200) : c.json(body, 503);
  });
```

In `apps/server/src/index.ts`, add the import and build the identity. Change the import of config to:

```ts
import { databaseNameFrom, loadConfig, loadGeminiConfig } from './config';
```

and add `identity` to the `createServerDeps` call:

```ts
  const deps = createServerDeps({
    db,
    logger,
    rng: Math.random,
    fetch: globalThis.fetch,
    gemini,
    translationTimeoutMs: config.translationTimeoutMs,
    // Resolved here, in the one place that reads the environment: app.ts must
    // not learn that a lane exists.
    identity: {
      lane: config.lane,
      database: databaseNameFrom(config.databaseUrl),
      port: config.port,
    },
  });
```

In `apps/server/tests/support/fakes.ts`, add to the object `createFakeAppDeps` returns, after `health`:

```ts
    identity: { lane: 'test', database: 'test_db', port: 0 },
```

In `apps/server/tests/support/serverDeps.ts`, add an optional override to the `io` parameter and pass it through. Add to the parameter type:

```ts
  identity?: { lane: string; database: string; port: number };
```

and to the `createServerDeps` call:

```ts
    identity: io.identity ?? { lane: 'test', database: 'test_db', port: 0 },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -w apps/server -- --testPathPattern 'app.test|openapi'
npm run typecheck
npm test
```

Expected: PASS, and `typecheck` clean across all workspaces.

- [ ] **Step 5: Run the database-backed tests too**

The integration suite builds real deps through `createTestServerDeps`; the added field must not have broken it.

```bash
npm run db:up
npm run test:integration -w apps/server
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/api/schemas.ts apps/server/src apps/server/tests/support
git commit -m "feat: /health names the lane, database and port that answered

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: A lane's database creates itself and says who owns it

`db:migrate` currently fails against a database nobody created. A lane needs its own, and a database on a shared Postgres needs to say which worktree it belongs to.

**Files:**
- Create: `apps/server/src/db/ensureDatabase.ts`
- Modify: `apps/server/src/db/cli.ts`
- Test: `apps/server/tests/integration/db/ensureDatabase.test.ts`

**Interfaces:**
- Consumes: `databaseNameFrom`, `maintenanceUrlFor`, `assertDatabaseIdentifier` (Task 2); `LANE`, `LANE_SLOT`, `LANE_ROOT`, `LANE_BRANCH`, `PORT` (Task 1).
- Produces:
  - `type LaneStamp = { lane: string; slot: string; port: string; root: string; branch: string }`
  - `ensureDatabase(databaseUrl: string, stamp: LaneStamp): Promise<boolean>` — resolves `true` when it created the database, `false` when it was already there. Always rewrites the comment.
  - `laneStampFrom(env: NodeJS.ProcessEnv): LaneStamp`
  - `formatLaneComment(stamp: LaneStamp, now: Date): string`
  - `parseLaneComment(comment: string | null): Partial<LaneStamp> & { stamped?: string }`

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/integration/db/ensureDatabase.test.ts`:

```ts
import { afterEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb } from '../../../src/db/client';
import {
  ensureDatabase,
  formatLaneComment,
  laneStampFrom,
  parseLaneComment,
} from '../../../src/db/ensureDatabase';
import { ADMIN_URL, urlFor } from '../../support/dbNames';

// A name of its own, outside the t_ sweep patterns, because this test creates a
// database the way a lane does rather than the way the harness does — and drops
// it itself in afterEach.
const NAME = 'lang_tutor_ensure_probe';

const STAMP = {
  lane: 'ensure_probe',
  slot: '7',
  port: '10001',
  root: '/tmp/worktrees/ensure-probe',
  branch: 'feature/ensure-probe',
};

async function admin<T>(fn: (db: ReturnType<typeof createDb>['db']) => Promise<T>): Promise<T> {
  const handle = createDb(ADMIN_URL, { max: 1, onError: () => {} });
  try {
    return await fn(handle.db);
  } finally {
    await handle.close();
  }
}

afterEach(async () => {
  await admin((db) => db.execute(sql.raw(`drop database if exists ${NAME} with (force)`)));
});

describe('ensureDatabase', () => {
  it('creates the database when it does not exist', async () => {
    const created = await ensureDatabase(urlFor(NAME), STAMP);
    expect(created).toBe(true);

    const found = await admin((db) =>
      db.execute<{ datname: string }>(sql`select datname from pg_database where datname = ${NAME}`),
    );
    expect(found.rows).toHaveLength(1);
  });

  it('is idempotent: a second call creates nothing and does not throw', async () => {
    await ensureDatabase(urlFor(NAME), STAMP);
    expect(await ensureDatabase(urlFor(NAME), STAMP)).toBe(false);
  });

  it('stamps the database with the worktree and branch that own it', async () => {
    await ensureDatabase(urlFor(NAME), STAMP);

    const result = await admin((db) =>
      db.execute<{ comment: string | null }>(sql`
        select shobj_description(oid, 'pg_database') as comment
        from pg_database where datname = ${NAME}
      `),
    );
    const parsed = parseLaneComment(result.rows[0]?.comment ?? null);
    expect(parsed.lane).toBe('ensure_probe');
    expect(parsed.slot).toBe('7');
    expect(parsed.port).toBe('10001');
    expect(parsed.root).toBe('/tmp/worktrees/ensure-probe');
    expect(parsed.branch).toBe('feature/ensure-probe');
    expect(parsed.stamped).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refreshes the stamp on a database that already exists', async () => {
    await ensureDatabase(urlFor(NAME), STAMP);
    await ensureDatabase(urlFor(NAME), { ...STAMP, branch: 'feature/renamed' });

    const result = await admin((db) =>
      db.execute<{ comment: string | null }>(sql`
        select shobj_description(oid, 'pg_database') as comment
        from pg_database where datname = ${NAME}
      `),
    );
    expect(parseLaneComment(result.rows[0]?.comment ?? null).branch).toBe('feature/renamed');
  });

  it('refuses a database name that is not a bare identifier', async () => {
    await expect(ensureDatabase(urlFor('drop me'), STAMP)).rejects.toThrow('database identifier');
  });
});

// Pure, and tested here rather than in src/: ADR 0004 R2 keeps a unit test away
// from anything that imports db/client.ts, and these ship in the module that
// does.
describe('the lane comment', () => {
  it('round-trips every field', () => {
    const comment = formatLaneComment(STAMP, new Date('2026-09-16T10:00:00.000Z'));
    expect(parseLaneComment(comment)).toEqual({ ...STAMP, stamped: '2026-09-16T10:00:00.000Z' });
  });

  it('survives a worktree path containing the separator', () => {
    const odd = { ...STAMP, root: '/tmp/a | b/wt' };
    const comment = formatLaneComment(odd, new Date('2026-09-16T10:00:00.000Z'));
    expect(parseLaneComment(comment).root).toBe('/tmp/a | b/wt');
  });

  it('reads an unstamped database as empty rather than throwing', () => {
    expect(parseLaneComment(null)).toEqual({});
    expect(parseLaneComment('a database somebody made by hand')).toEqual({});
  });
});

describe('laneStampFrom', () => {
  it('takes lane 0 as the default for an empty environment', () => {
    expect(laneStampFrom({})).toEqual({
      lane: 'main',
      slot: '0',
      port: '3001',
      root: process.cwd(),
      branch: 'unknown',
    });
  });

  it('takes every field from the environment when the wrapper set it', () => {
    expect(
      laneStampFrom({
        LANE: 'phase_15',
        LANE_SLOT: '1',
        PORT: '4001',
        LANE_ROOT: '/w/phase-15',
        LANE_BRANCH: 'phase-15-lanes',
      }),
    ).toEqual({
      lane: 'phase_15',
      slot: '1',
      port: '4001',
      root: '/w/phase-15',
      branch: 'phase-15-lanes',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run db:up
npm run test:integration -w apps/server -- --testPathPattern ensureDatabase
```

Expected: FAIL — `Cannot find module '../../../src/db/ensureDatabase'`.

- [ ] **Step 3: Implement**

Create `apps/server/src/db/ensureDatabase.ts`:

```ts
import { sql } from 'drizzle-orm';

import { assertDatabaseIdentifier, databaseNameFrom, maintenanceUrlFor } from '../config';
import { createDb } from './client';

/**
 * Who owns a database on the shared Postgres. Every value is a string because
 * every value came from the environment, and re-parsing a port only to print it
 * again would buy nothing.
 */
export type LaneStamp = {
  lane: string;
  slot: string;
  port: string;
  root: string;
  branch: string;
};

/** The lane this process belongs to, defaulting to lane 0 field by field. */
export function laneStampFrom(env: NodeJS.ProcessEnv): LaneStamp {
  return {
    lane: env.LANE?.trim() || 'main',
    slot: env.LANE_SLOT?.trim() || '0',
    port: env.PORT?.trim() || '3001',
    // A checkout run outside the wrapper still stamps something true: cwd is
    // where the command was issued.
    root: env.LANE_ROOT?.trim() || process.cwd(),
    branch: env.LANE_BRANCH?.trim() || 'unknown',
  };
}

// ` | ` separates fields and `=` separates key from value. A worktree path may
// contain either, so parsing splits on the FIRST `=` per field and the value is
// whatever follows — which is why the fields are written in a fixed order and
// read back by key rather than by position.
const SEPARATOR = ' | ';

export function formatLaneComment(stamp: LaneStamp, now: Date): string {
  return [
    `lane=${stamp.lane}`,
    `slot=${stamp.slot}`,
    `port=${stamp.port}`,
    `branch=${stamp.branch}`,
    `stamped=${now.toISOString()}`,
    // Last, and deliberately: a path is the one field that can contain the
    // separator, so nothing has to be parsed after it.
    `root=${stamp.root}`,
  ].join(SEPARATOR);
}

export function parseLaneComment(
  comment: string | null,
): Partial<LaneStamp> & { stamped?: string } {
  if (!comment) return {};
  const out: Record<string, string> = {};
  // `root=` is last and may contain the separator, so it is taken whole from
  // where it starts rather than from a split.
  const rootAt = comment.indexOf(`${SEPARATOR}root=`);
  const head = rootAt === -1 ? comment : comment.slice(0, rootAt);
  if (rootAt !== -1) out.root = comment.slice(rootAt + SEPARATOR.length + 'root='.length);

  for (const field of head.split(SEPARATOR)) {
    const at = field.indexOf('=');
    if (at === -1) continue;
    out[field.slice(0, at)] = field.slice(at + 1);
  }
  // A comment somebody wrote by hand is not a stamp; report nothing rather than
  // a half-read one.
  if (!out.lane) return {};
  return out;
}

/**
 * Creates the database named by `databaseUrl` if it is absent, then stamps it.
 *
 * A lane's database is not in any migration and nothing else creates it — a
 * fresh worktree would otherwise have to be told a `createdb` command it cannot
 * derive. Resolves true when it created one, false when it was already there;
 * the stamp is rewritten either way, so a renamed branch is reflected on the
 * next migrate.
 */
export async function ensureDatabase(databaseUrl: string, stamp: LaneStamp): Promise<boolean> {
  const name = databaseNameFrom(databaseUrl);
  // Before connecting anywhere: an illegal name is a bug in the formula, and it
  // must not reach an interpolated statement even to fail there.
  assertDatabaseIdentifier(name);

  const admin = createDb(maintenanceUrlFor(databaseUrl), { max: 1, onError: () => {} });
  try {
    const existing = await admin.db.execute<{ datname: string }>(
      sql`select datname from pg_database where datname = ${name}`,
    );
    const created = existing.rows.length === 0;
    if (created) {
      // An identifier cannot be a bound parameter. assertDatabaseIdentifier
      // above is what makes this interpolation safe.
      await admin.db.execute(sql.raw(`create database ${name}`));
    }
    const comment = formatLaneComment(stamp, new Date()).replace(/'/g, "''");
    await admin.db.execute(sql.raw(`comment on database ${name} is '${comment}'`));
    return created;
  } finally {
    await admin.close();
  }
}
```

In `apps/server/src/db/cli.ts`, add the import:

```ts
import { ensureDatabase, laneStampFrom } from './ensureDatabase';
```

and inside `main()`, immediately after `const { databaseUrl, poolMax } = loadConfig(process.env);`:

```ts
  // Before the pool: a lane's database is created by nothing else, and opening a
  // pool against a database that does not exist fails with a driver error that
  // reads like a configuration mistake.
  if (await ensureDatabase(databaseUrl, laneStampFrom(process.env))) {
    console.log(`created ${databaseUrl}`);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test:integration -w apps/server -- --testPathPattern ensureDatabase
```

Expected: PASS, nine tests.

- [ ] **Step 5: Prove it end to end against a database that does not exist**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/lang_tutor_probe \
LANE=probe LANE_SLOT=1 PORT=4001 LANE_ROOT=/tmp/probe LANE_BRANCH=probe-branch \
  npm run db:migrate -w apps/server
docker exec lang-tutor-db-1 psql -U postgres -c "\l+ lang_tutor_probe" | head -5
docker exec lang-tutor-db-1 psql -U postgres -c "drop database lang_tutor_probe with (force)"
```

Expected: the migrate run prints `created postgres://...lang_tutor_probe` and then `migrated and seeded ...`; `\l+` shows the description containing `lane=probe` and `branch=probe-branch`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/ensureDatabase.ts apps/server/src/db/cli.ts \
  apps/server/tests/integration/db/ensureDatabase.test.ts
git commit -m "feat: a lane's database creates itself and records the worktree that owns it

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Listing and dropping lanes

The human view of the shared Postgres, and the cleanup that must happen before `git worktree remove`.

**Files:**
- Create: `apps/server/src/db/lanes.ts`
- Modify: `apps/server/src/db/cli.ts`
- Modify: `apps/server/package.json`
- Test: `apps/server/tests/integration/db/lanes.test.ts`

**Interfaces:**
- Consumes: `parseLaneComment`, `ensureDatabase`, `LaneStamp` (Task 4); `maintenanceUrlFor` (Task 2).
- Produces:
  - `type LaneDatabaseRow = { name: string; comment: string | null }`
  - `listLaneDatabases(db: Db): Promise<LaneDatabaseRow[]>` — every `lang_tutor*` database, name-ordered.
  - `dropLaneDatabases(db: Db, lane: string): Promise<string[]>` — drops `lang_tutor_<lane>`, `lang_tutor_e2e_<lane>` and `t_<lane>_*`; returns what it dropped, name-ordered. Throws for `main` or an empty name.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/integration/db/lanes.test.ts`:

```ts
import { afterEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createDb, type Db } from '../../../src/db/client';
import { ensureDatabase } from '../../../src/db/ensureDatabase';
import { dropLaneDatabases, listLaneDatabases } from '../../../src/db/lanes';
import { ADMIN_URL, urlFor } from '../../support/dbNames';

const LANE = 'lanes_probe';
const MADE = [
  `lang_tutor_${LANE}`,
  `lang_tutor_e2e_${LANE}`,
  `t_${LANE}_tmpl_1`,
  `t_${LANE}_test_a_0badc0de`,
];

const STAMP = {
  lane: LANE,
  slot: '8',
  port: '11001',
  root: '/tmp/worktrees/lanes-probe',
  branch: 'feature/lanes-probe',
};

async function admin<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const handle = createDb(ADMIN_URL, { max: 1, onError: () => {} });
  try {
    return await fn(handle.db);
  } finally {
    await handle.close();
  }
}

async function createAll(): Promise<void> {
  await ensureDatabase(urlFor(MADE[0]), STAMP);
  await admin(async (db) => {
    for (const name of MADE.slice(1)) {
      await db.execute(sql.raw(`create database ${name}`));
    }
  });
}

afterEach(async () => {
  await admin(async (db) => {
    for (const name of MADE) {
      await db.execute(sql.raw(`drop database if exists ${name} with (force)`));
    }
  });
});

describe('listLaneDatabases', () => {
  it('reports each lane database with the stamp that says who owns it', async () => {
    await createAll();
    const rows = await admin(listLaneDatabases);
    const dev = rows.find((row) => row.name === `lang_tutor_${LANE}`);
    expect(dev).toBeDefined();
    expect(dev?.comment).toContain(`lane=${LANE}`);
    expect(dev?.comment).toContain('branch=feature/lanes-probe');
  });

  it('includes lane 0 and the e2e database, and excludes the per-test databases', async () => {
    await createAll();
    const names = (await admin(listLaneDatabases)).map((row) => row.name);
    expect(names).toContain('lang_tutor');
    expect(names).toContain(`lang_tutor_e2e_${LANE}`);
    // Per-test databases are the harness's business and would drown the list —
    // a single integration run leaves upwards of a hundred.
    expect(names).not.toContain(`t_${LANE}_test_a_0badc0de`);
  });
});

describe('dropLaneDatabases', () => {
  it('drops the dev, e2e and per-test databases of one lane and nothing else', async () => {
    await createAll();
    const dropped = await admin((db) => dropLaneDatabases(db, LANE));
    expect(dropped.sort()).toEqual([...MADE].sort());

    const left = await admin((db) =>
      db.execute<{ datname: string }>(
        sql`select datname from pg_database where datname like ${'%' + LANE + '%'}`,
      ),
    );
    expect(left.rows).toEqual([]);

    // The shared dictionary database is somebody's working data.
    const zero = await admin((db) =>
      db.execute<{ datname: string }>(
        sql`select datname from pg_database where datname = 'lang_tutor'`,
      ),
    );
    expect(zero.rows).toHaveLength(1);
  });

  it('reports nothing for a lane that has no databases', async () => {
    expect(await admin((db) => dropLaneDatabases(db, 'never_existed'))).toEqual([]);
  });

  it('refuses lane 0 and an empty name, which would take the shared databases', async () => {
    await expect(admin((db) => dropLaneDatabases(db, 'main'))).rejects.toThrow('lane 0');
    await expect(admin((db) => dropLaneDatabases(db, ''))).rejects.toThrow('lane name');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:integration -w apps/server -- --testPathPattern lanes
```

Expected: FAIL — `Cannot find module '../../../src/db/lanes'`.

- [ ] **Step 3: Implement the queries**

Create `apps/server/src/db/lanes.ts`:

```ts
import { sql } from 'drizzle-orm';

import { assertDatabaseIdentifier } from '../config';
import type { Db } from './client';

export type LaneDatabaseRow = { name: string; comment: string | null };

// `lang_tutor` itself and anything prefixed `lang_tutor_`. Per-test databases
// are deliberately outside this: one integration run leaves upwards of a
// hundred, and they belong to the harness that sweeps them, not to a listing a
// human reads.
const LANE_DATABASE_PATTERN = '^lang_tutor(_|$)';

export async function listLaneDatabases(db: Db): Promise<LaneDatabaseRow[]> {
  const result = await db.execute<{ name: string; comment: string | null }>(sql`
    select datname as name, shobj_description(oid, 'pg_database') as comment
    from pg_database
    where datname ~ ${LANE_DATABASE_PATTERN}
    order by datname
  `);
  return result.rows;
}

/**
 * Everything one lane owns: its dev database, its e2e database and every
 * per-test database its suites left behind.
 *
 * Anchored alternation rather than a prefix match, because `t_<lane>_` is the
 * only one of the three that is a prefix — `lang_tutor_<lane>` must not also
 * sweep `lang_tutor_<lane>_something`, which is a different lane's.
 */
export async function dropLaneDatabases(db: Db, lane: string): Promise<string[]> {
  if (!lane) throw new Error('a lane name is required');
  if (lane === 'main') {
    throw new Error('refusing to drop lane 0 — lang_tutor is the shared dictionary');
  }
  assertDatabaseIdentifier(lane);

  const pattern = `^(lang_tutor_${lane}|lang_tutor_e2e_${lane}|t_${lane}_.*)$`;
  const found = await db.execute<{ datname: string }>(
    sql`select datname from pg_database where datname ~ ${pattern} order by datname`,
  );

  const dropped: string[] = [];
  for (const { datname } of found.rows) {
    const quoted = `"${datname.replace(/"/g, '""')}"`;
    await db.execute(sql.raw(`drop database if exists ${quoted} with (force)`));
    dropped.push(datname);
  }
  return dropped;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test:integration -w apps/server -- --testPathPattern lanes
```

Expected: PASS, five tests.

- [ ] **Step 5: Wire the two flags into the CLI**

In `apps/server/src/db/cli.ts`, extend the import of config to include `maintenanceUrlFor`, add:

```ts
import { existsSync } from 'node:fs';
```

and the imports from the two new modules:

```ts
import { parseLaneComment } from './ensureDatabase';
import { dropLaneDatabases, listLaneDatabases } from './lanes';
```

Add these functions above `main()`:

```ts
/** `--lane-down <name>`, or the current lane when the name is omitted. */
function laneDownTarget(currentLane: string): string | undefined {
  const index = process.argv.indexOf('--lane-down');
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : currentLane;
}

/**
 * What a server on this port claims to be, or undefined if nothing answers.
 * This is the whole point of the listing: a port that answers is not proof that
 * the lane you think owns it is the one that replied.
 */
async function laneAnswering(port: string): Promise<string | undefined> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    const body = (await res.json()) as { lane?: string };
    return body.lane ?? 'unnamed';
  } catch {
    return undefined;
  }
}

async function printLanes(databaseUrl: string): Promise<void> {
  const admin = createDb(maintenanceUrlFor(databaseUrl), { max: 1, onError: () => {} });
  try {
    const rows = await listLaneDatabases(admin.db);
    for (const row of rows) {
      const stamp = parseLaneComment(row.comment);
      const lane = stamp.lane ?? (row.name === 'lang_tutor' ? 'main' : '?');
      const port = stamp.port ?? (row.name === 'lang_tutor' ? '3001' : undefined);
      const serving = port ? await laneAnswering(port) : undefined;

      const notes: string[] = [];
      if (stamp.branch) notes.push(`branch ${stamp.branch}`);
      if (port) {
        notes.push(
          serving === undefined
            ? `:${port} idle`
            : serving === lane
              ? `:${port} serving`
              : `:${port} SERVED BY LANE ${serving}`,
        );
      }
      // A worktree that is gone leaves its databases behind. Naming them is the
      // only way anyone finds them again.
      if (stamp.root && !existsSync(stamp.root)) {
        notes.push(`ORPHAN — worktree ${stamp.root} is gone; npm run lane:down -- ${lane}`);
      }
      console.log(`${row.name.padEnd(36)} lane ${lane.padEnd(26)} ${notes.join('  |  ')}`);
    }
  } finally {
    await admin.close();
  }
}

async function dropLane(databaseUrl: string, lane: string): Promise<void> {
  const admin = createDb(maintenanceUrlFor(databaseUrl), { max: 1, onError: () => {} });
  try {
    const dropped = await dropLaneDatabases(admin.db, lane);
    if (dropped.length === 0) {
      console.log(`lane ${lane} owns no databases`);
      return;
    }
    for (const name of dropped) console.log(`dropped ${name}`);
    console.log(`\nThe worktree itself is still there. Remove it with 'git worktree remove'.`);
  } finally {
    await admin.close();
  }
}
```

Widen `main()`'s first line to keep the lane, then insert the two flag branches immediately below it — **before** the `ensureDatabase` call added in Task 4:

```ts
  const { databaseUrl, poolMax, lane } = loadConfig(process.env);

  // Both of these run against the maintenance database and must not create or
  // migrate anything — `--lane-down` in particular is about to drop the very
  // database ensureDatabase would otherwise make.
  if (process.argv.includes('--lane-list')) {
    await printLanes(databaseUrl);
    return;
  }
  const downTarget = laneDownTarget(lane);
  if (downTarget !== undefined) {
    await dropLane(databaseUrl, downTarget);
    return;
  }
```

In `apps/server/package.json`, add to `scripts`:

```json
    "lane:list": "tsx src/db/cli.ts --lane-list",
    "lane:down": "tsx src/db/cli.ts --lane-down",
```

- [ ] **Step 6: Exercise both flags by hand**

```bash
npm run lane:list -w apps/server
LANE=throwaway LANE_SLOT=9 PORT=12001 LANE_BRANCH=throwaway \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/lang_tutor_throwaway \
  npm run db:migrate -w apps/server
npm run lane:list -w apps/server
npm run lane:down -w apps/server throwaway
npm run lane:list -w apps/server
```

Expected: the first listing shows `lang_tutor` as lane `main`; the second adds `lang_tutor_throwaway` as lane `throwaway` with `ORPHAN` (its `LANE_ROOT` defaulted to a directory that does exist, so the orphan note may be absent — either is correct here); `lane:down` prints `dropped lang_tutor_throwaway`; the last listing no longer shows it.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/lanes.ts apps/server/src/db/cli.ts apps/server/package.json \
  apps/server/tests/integration/db/lanes.test.ts
git commit -m "feat: list the lanes on the shared Postgres and drop one cleanly

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Test databases are prefixed per lane

Today's sweep drops every `t_test_*` and `t_tmpl_*` database it finds. Two checkouts running the integration suite at once therefore drop each other's live databases mid-run. After this task a lane sweeps only its own.

**Files:**
- Modify: `apps/server/tests/support/dbNames.ts`
- Modify: `apps/server/tests/support/globalSetup.ts`
- Modify: `apps/server/tests/support/globalTeardown.ts`
- Modify: `.github/workflows/ci.yml`
- Test: `apps/server/tests/integration/support/isolation.test.ts`

**Interfaces:**
- Consumes: `TEST_DB_PREFIX` (Task 1).
- Produces: `dbPrefix(): string` exported from `dbNames.ts`, default `t_`. `templateName` and `testDbName` are prefixed by it; `sweepPattern(): string` returns the anchored regex the sweep uses.

- [ ] **Step 1: Write the failing test**

In `apps/server/tests/integration/support/isolation.test.ts`, replace the import of `dbNames` and the name assertion test:

```ts
import { ADMIN_URL, dbPrefix } from '../../support/dbNames';
```

```ts
  it('names the database after the test, under this lane\'s prefix', async () => {
    // The slug is the full "describe > it" name, so it is long enough to be
    // truncated — which is the interesting half of the assertion. The budget is
    // computed from the prefix, not from a constant: a lane's prefix is longer
    // than lane 0's bare `t_`, and a fixed budget would overrun the 63-byte
    // identifier limit and silently collide two tests.
    const prefix = dbPrefix();
    expect(current.name.startsWith(`${prefix}test_`)).toBe(true);
    expect(current.name).toMatch(
      new RegExp(`^${prefix}test_per_test_database_isolation_names_the_data[a-z_]*_[0-9a-f]{8}$`),
    );
    expect(current.name.length).toBeLessThanOrEqual(63);
  });

  it('takes its prefix from the environment, so two checkouts never collide', async () => {
    // Not a tautology: this is the assertion that fails if TEST_DB_PREFIX is
    // read once at import time by one module and ignored by another.
    expect(dbPrefix()).toBe(process.env.TEST_DB_PREFIX ?? 't_');
  });
```

Keep the existing `COMMENT ON DATABASE` assertions; move them into the first test's body unchanged, after the length assertion, replacing its old regex only.

- [ ] **Step 2: Run the test under a lane prefix and watch it fail**

```bash
TEST_DB_PREFIX=t_probe_ npm run test:integration -w apps/server -- --testPathPattern isolation
```

Expected: FAIL — `dbPrefix is not exported`, and once that is added, the database name still starting `t_test_` because nothing reads the variable.

- [ ] **Step 3: Implement**

In `apps/server/tests/support/dbNames.ts`, add after the `urlFor` function:

```ts
/**
 * The prefix every test database of THIS checkout carries.
 *
 * Read per call rather than captured at import: globalSetup, globalTeardown and
 * the workers are separate processes, and a value captured in one of them is
 * not the value another would see. `t_` is lane 0's, which is what every
 * checkout used before lanes existed.
 *
 * This is the whole of the cross-checkout fix. The sweep below drops by pattern,
 * so two checkouts sharing a prefix would drop each other's live databases
 * mid-run — templates included.
 */
export function dbPrefix(): string {
  return process.env.TEST_DB_PREFIX ?? 't_';
}

/** The anchored regex globalSetup sweeps by: this lane's databases and no others. */
export function sweepPattern(): string {
  return `^${dbPrefix()}(test|tmpl)_`;
}
```

Change `templateName` to:

```ts
export function templateName(workerId: string | number): string {
  return `${dbPrefix()}tmpl_${workerId}`;
}
```

Change the body of `testDbName` to compute its budget from the prefix:

```ts
export function testDbName(testName: string, random: string): string {
  const prefix = `${dbPrefix()}test_`;
  const budget = MAX_IDENTIFIER_BYTES - prefix.length - 1 - random.length;
  const slug = slugify(testName).slice(0, budget).replace(/_+$/, '') || 'unnamed';
  return `${prefix}${slug}_${random}`;
}
```

In `apps/server/tests/support/globalSetup.ts`, change the import to include `sweepPattern` and replace the sweep query's pattern argument:

```ts
    const stale = await admin.db.execute<{ datname: string }>(
      sql`select datname from pg_database where datname ~ ${sweepPattern()}`,
    );
```

Update that block's comment to add a sentence:

```
    // Since phase 15 the prefix is this lane's, so a second checkout running the
    // same suite at the same time sweeps its own databases and not this one's.
```

`globalTeardown.ts` needs no change: it drops by `templateName(worker)`, which is now prefixed.

In `.github/workflows/ci.yml`, in the `test-integration` job, replace the final step with:

```yaml
      # A prefix of its own, which is how the lane mechanism is exercised on
      # every push: a prefix that some module ignored would leave databases named
      # `t_test_*` behind, and tests/integration/support/isolation.test.ts fails
      # on exactly that.
      - run: npm run test:integration
        env:
          TEST_DB_PREFIX: t_ci_
```

- [ ] **Step 4: Run the tests to verify they pass, under both prefixes**

```bash
TEST_DB_PREFIX=t_probe_ npm run test:integration -w apps/server -- --testPathPattern isolation
npm run test:integration -w apps/server -- --testPathPattern isolation
docker exec lang-tutor-db-1 psql -U postgres -tAc \
  "select count(*) from pg_database where datname like 't\_probe\_%'"
```

Expected: both runs PASS. The count is greater than zero — the probe run's databases survive on purpose, which is what the second run's own sweep must have left alone.

- [ ] **Step 5: Prove the sweep stays in its lane**

```bash
docker exec lang-tutor-db-1 psql -U postgres -qc "create database t_other_tmpl_1"
TEST_DB_PREFIX=t_probe_ npm run test:integration -w apps/server -- --testPathPattern isolation
docker exec lang-tutor-db-1 psql -U postgres -tAc \
  "select datname from pg_database where datname = 't_other_tmpl_1'"
docker exec lang-tutor-db-1 psql -U postgres -qc "drop database t_other_tmpl_1 with (force)"
docker exec lang-tutor-db-1 psql -U postgres -qc "drop database if exists t_probe_tmpl_1 with (force)"
```

Expected: `t_other_tmpl_1` is still listed after the run. Before this task it would have been dropped.

- [ ] **Step 6: Full integration suite, then commit**

```bash
npm run test:integration
git add apps/server/tests/support apps/server/tests/integration/support/isolation.test.ts \
  .github/workflows/ci.yml
git commit -m "feat: prefix test databases per lane so one checkout's sweep spares another's

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The e2e suite runs in its own lane, on its own port

Two changes: every address comes from the environment, and the e2e server stops sharing the dev server's port. Today `reuseExistingServer: !CI` attaches a local e2e run to whatever holds 3001, which is the dev server on `lang_tutor` talking to the real Gemini API.

**Files:**
- Modify: `e2e/urls.ts`
- Modify: `e2e/globalSetup.ts`
- Modify: `e2e/tests/support/mockServer.ts`
- Modify: `e2e/playwright.config.ts`
- Modify: `apps/mobile/package.json`

**Interfaces:**
- Consumes: `E2E_API_URL`, `E2E_APP_URL`, `E2E_APP_PORT`, `E2E_DATABASE_URL`, `E2E_MOCK_NAMESPACE`, `MOCKSERVER_URL`, `LANE` (Task 1); `databaseNameFrom` (Task 2).
- Produces: `requireEnv(name: string): string` exported from `e2e/urls.ts`.

This suite keeps **no** default of its own. Every other consumer defaults to lane 0 so that an unset environment behaves as it always did, but the e2e suite is only ever started through `npm run e2e`, which is wrapped — so a default here could only ever be wrong silently, and a missing variable is a mistake worth a loud message.

- [ ] **Step 1: Read the environment in `e2e/urls.ts`**

Replace the whole file:

```ts
/**
 * Every address this suite uses, and the one place it reads them.
 *
 * No defaults, deliberately, and this is the one consumer in the repo with
 * none. The suite is always started through `npm run e2e`, which runs it under
 * scripts/lane-env.sh; a default would therefore never be the right answer, it
 * would just be a wrong one nobody noticed. `npx playwright test` on its own is
 * not supported and says so.
 */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Run the e2e suite with 'npm run e2e', which derives ` +
        'every address for this lane through scripts/lane-env.sh.',
    );
  }
  return value;
}

/**
 * The Hono server started by playwright.config.ts's first webServer entry.
 *
 * A port of its own since phase 15, never the dev server's. Before it,
 * `reuseExistingServer` attached a local run to whatever held the dev port — in
 * practice a developer's own server, on the dictionary database, calling the
 * real provider. A port of its own makes that impossible rather than unlikely.
 */
export const API_URL = requireEnv('E2E_API_URL');

/** The static web export served by the second webServer entry. */
export const APP_URL = requireEnv('E2E_APP_URL');

/** The shared MockServer compose service, standing in for the Gemini API. */
export const MOCKSERVER_URL = requireEnv('MOCKSERVER_URL');
```

- [ ] **Step 2: Read the environment in `e2e/globalSetup.ts`**

Add to the imports:

```ts
import { databaseNameFrom } from '../apps/server/src/config';
import { MOCKSERVER_URL, requireEnv } from './urls';
```

and replace the constants at the top (dropping the existing `MOCKSERVER_URL` import line, now covered above):

```ts
const HOST = process.env.PGHOST ?? 'localhost';
const PORT = process.env.PGPORT ?? '5432';
const ADMIN_URL = `postgres://postgres:postgres@${HOST}:${PORT}/postgres`;

// This lane's e2e database. Dropped and rebuilt per run, which is exactly why it
// must not be shared between checkouts.
export const E2E_DATABASE_URL = requireEnv('E2E_DATABASE_URL');
export const E2E_DATABASE = databaseNameFrom(E2E_DATABASE_URL);
```

The rest of the file is unchanged: it already interpolates `E2E_DATABASE` into its drop and create.

- [ ] **Step 3: Read the environment in `e2e/tests/support/mockServer.ts`**

```ts
import { MOCKSERVER_URL, requireEnv } from '../../urls';

/**
 * One namespace for the whole run rather than one per test: the server is a
 * single long-lived process with a single GEMINI_BASE_URL in its environment.
 * Safe because playwright.config.ts already runs `workers: 1` with
 * `fullyParallel: false`, and each spec clears the namespace before it registers.
 *
 * Per lane since phase 15, because "clears the namespace before it registers" is
 * only safe while one run owns it.
 */
export const E2E_MOCK_NAMESPACE = requireEnv('E2E_MOCK_NAMESPACE');
```

- [ ] **Step 4: Give the servers their ports in `e2e/playwright.config.ts`**

In the first `webServer` entry, replace `env` and `reuseExistingServer`:

```ts
      env: {
        PORT: String(new URL(API_URL).port),
        DATABASE_URL: E2E_DATABASE_URL,
        // Published on /health, so a probe that reaches the wrong server says so.
        LANE: process.env.LANE ?? 'main',
        // Only the base URL differs from production. There is no stub mode
        // inside the server.
        GEMINI_BASE_URL: `${MOCKSERVER_URL}/${E2E_MOCK_NAMESPACE}`,
        GEMINI_API_KEY: 'e2e',
        GEMINI_MODEL: 'e2e-model',
      },
      url: `${API_URL}/health`,
      // Never reuse, not even locally. Until phase 15 this was `!process.env.CI`,
      // and on a developer's machine it silently attached the suite to whatever
      // held the port — the dev server, on the dictionary database, calling the
      // real provider. This entry now has a port of its own, so an occupied one
      // means a stray process and must fail the run loudly.
      reuseExistingServer: false,
```

In the second entry, add `E2E_APP_PORT` to its `env` so the serve command binds this lane's port:

```ts
      env: { EXPO_PUBLIC_API_URL: API_URL, E2E_APP_PORT: new URL(APP_URL).port },
```

and update the comment above `command` to replace "Served on 8082, not Metro's default 8081" with:

```
      // Served on this lane's e2e app port, never Metro's: reuseExistingServer
      // must never let this entry silently attach to a `npm run mobile` dev
      // server a developer happens to have running.
```

- [ ] **Step 5: Let the static server take its port from the environment**

In `apps/mobile/package.json`:

```json
    "start": "expo start --port ${METRO_PORT:-8081}",
    "serve:web": "expo serve dist --port ${E2E_APP_PORT:-8082}",
```

- [ ] **Step 6: Run the e2e suite and verify it uses the new port**

```bash
npm run db:up
npm run e2e
```

Expected: PASS. While it runs, in another terminal, confirm the server is on 3002 and names lane 0:

```bash
curl -s localhost:3002/health
```

Expected: `{"lane":"main","database":"lang_tutor_e2e","port":3002,"ok":true}`.

- [ ] **Step 7: Prove it no longer attaches to the dev server**

```bash
GEMINI_BASE_URL=http://localhost:1080/dev GEMINI_API_KEY=dev GEMINI_MODEL=dev \
  npm run server &
sleep 5
npm run e2e
```

Expected: PASS, with the suite's own server on 3002 alongside the dev server on 3001. Before this task the suite would have run against the dev server's database. Stop the dev server afterwards:

```bash
kill %1
```

- [ ] **Step 8: Commit**

```bash
git add e2e apps/mobile/package.json
git commit -m "feat: e2e takes its addresses from the lane and stops sharing the dev port

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Every script runs through the lane

The wrapper only helps if nothing bypasses it. This task routes every start-or-test script through `lane-env.sh` and turns the documented `db:up` trap into an error.

**Files:**
- Create: `scripts/db-up.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: `scripts/lane-env.sh` (Task 1), `apps/server`'s `lane:list` / `lane:down` scripts (Task 5).
- Produces: the wrapped root scripts that ADR 0006 R2 will check for.

- [ ] **Step 1: Write the compose guard**

Create `scripts/db-up.sh`:

```bash
#!/usr/bin/env bash
#
# Starts the two shared containers, and refuses to do it from the wrong place.
#
# docker compose derives its project name from the directory, so running this
# from a worktree starts a SECOND Postgres and fails with "port is already
# allocated" — after having created a container nobody wanted. The running one
# serves every checkout equally well: each lane has its own databases on it, and
# the integration suites clone per-test databases off it either way.
#
# Run through scripts/lane-env.sh, which is what sets LANE_SLOT.

set -u

cd "$(dirname "$0")/.." || exit 1

if [ "${LANE_SLOT:-0}" != "0" ] && docker ps --format '{{.Image}}' 2>/dev/null | grep -q '^postgres:'; then
  echo "Postgres is already running, started from the main checkout." >&2
  echo "This is lane ${LANE:-?} (slot ${LANE_SLOT}), and compose would start a second" >&2
  echo "container here and fail on port ${PGPORT:-5432}. Use the running one: this" >&2
  echo "lane's databases live on it, and ./scripts/setup-worktree.sh created them." >&2
  exit 1
fi

docker compose up -d --wait db mockserver || exit 1
bash scripts/wait-for-mockserver.sh
```

- [ ] **Step 2: Wrap every script**

In `package.json`, replace the `scripts` block with:

```json
  "scripts": {
    "mobile": "bash scripts/lane-env.sh npm run start --workspace apps/mobile",
    "server": "bash scripts/lane-env.sh npm run dev --workspace apps/server",
    "e2e": "bash scripts/lane-env.sh npm run e2e --workspace e2e",
    "test": "npm run test:unit && echo '' && echo 'Note: unit tests only. Run npm run test:all before pushing - database-backed tests did not run.'",
    "test:unit": "npm test --workspaces --if-present",
    "test:integration": "bash scripts/lane-env.sh npm run test:integration --workspaces --if-present",
    "test:all": "npm run test:unit && npm run test:integration",
    "test:lanes": "bash scripts/test-lane-env.sh",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "lint:arch": "bash scripts/check-adrs.sh",
    "lane:list": "bash scripts/lane-env.sh npm run lane:list --workspace apps/server",
    "lane:down": "bash scripts/lane-env.sh npm run lane:down --workspace apps/server --",
    "db:up": "bash scripts/lane-env.sh bash scripts/db-up.sh",
    "db:down": "docker compose down",
    "db:migrate": "bash scripts/lane-env.sh npm run db:migrate --workspace apps/server",
    "db:reseed": "bash scripts/lane-env.sh npm run db:reseed --workspace apps/server",
    "dict:export": "bash scripts/lane-env.sh npm run dict:export --workspace apps/server",
    "dict:restore": "bash scripts/lane-env.sh npm run dict:restore --workspace apps/server",
    "eval": "npm run eval --workspace apps/server",
    "content:generate": "npm run content:generate --workspace apps/server"
  }
```

`test:unit` is deliberately unwrapped: ADR 0004 keeps the unit bucket away from every database and port, so a lane means nothing to it. `db:down` is unwrapped because it stops the shared containers, which is a lane-0 act. `eval` and `content:generate` call the real provider and touch no lane resource.

- [ ] **Step 3: Verify every wrapped script still works from lane 0**

```bash
npm run db:up
npm run lane:list
npm run test:integration
npm run db:migrate
```

Expected: all four succeed, with identical behaviour to before. `lane:list` prints `lang_tutor  lane main`.

- [ ] **Step 4: Verify `lane:down` reaches its argument through the wrapper**

```bash
npm run lane:down -- never_existed
```

Expected: `lane never_existed owns no databases`.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/db-up.sh
git commit -m "feat: route every start-or-test script through the lane wrapper

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: A worktree sets itself up as a lane

`setup-worktree.sh` already exists and both CLAUDE.md and the SessionStart hook point at it. It gains the three steps that make a worktree a lane.

**Files:**
- Modify: `scripts/setup-worktree.sh`
- Modify: `.claude/settings.json`

**Interfaces:**
- Consumes: `lane-env.sh --allocate` and `--export` (Task 1), `npm run db:migrate` (Tasks 4 and 8).
- Produces: a worktree with `.lane`, a generated `apps/mobile/.env.local`, and its dev database created, migrated and seeded.

- [ ] **Step 1: Allocate the slot and import the lane**

In `scripts/setup-worktree.sh`, after the `MAIN`/`HERE` block and before `status=0`, insert:

```bash
# --- 0. the lane -------------------------------------------------------------
# A slot, and from it every port and database name this checkout will use. The
# main checkout is lane 0 and needs no .lane file; a worktree is allocated the
# lowest free slot, once, and keeps it.
if [ "$HERE" != "$MAIN" ] && [ ! -f .lane ]; then
  slot=$(bash scripts/lane-env.sh --allocate) || exit 1
  echo "  created    .lane — this checkout is lane slot $slot"
fi

eval "$(bash scripts/lane-env.sh --export)" || exit 1
echo "  ok         lane $LANE (slot $LANE_SLOT) on branch $LANE_BRANCH"
echo "             server :$PORT   metro :$METRO_PORT   database $(basename "$DATABASE_URL")"
```

- [ ] **Step 2: Generate the mobile env file instead of copying it**

Replace the whole `--- 1. the mobile env file ---` block with:

```bash
# --- 1. the mobile env file --------------------------------------------------
# EXPO_PUBLIC_API_URL is read at module scope in apps/mobile/src/app/_layout.tsx
# (Metro inlines EXPO_PUBLIC_* at build time, which is why it is read there and
# not through an indirection). Missing file, no app.
#
# GENERATED, not copied. A copied file carries the main checkout's port, so a
# lane's app would call lane 0's server — silently, because the app works
# perfectly against the wrong server. The host comes from the main checkout's
# file, so a LAN IP set once serves every lane; the port is always this lane's.
desired="EXPO_PUBLIC_API_URL=$EXPO_PUBLIC_API_URL"
if [ -f apps/mobile/.env.local ] && grep -qxF "$desired" apps/mobile/.env.local; then
  echo "  ok         apps/mobile/.env.local points at this lane ($EXPO_PUBLIC_API_URL)"
else
  if [ -f apps/mobile/.env.local ]; then
    echo "  rewriting  apps/mobile/.env.local — it did not point at this lane's server"
  fi
  {
    echo "# Generated by scripts/setup-worktree.sh for lane $LANE (slot $LANE_SLOT)."
    echo "# The port is this lane's; the host comes from the main checkout, or from"
    echo "# LANE_API_HOST. Re-run the script after changing either."
    echo "$desired"
  } > apps/mobile/.env.local
  echo "  created    apps/mobile/.env.local -> $EXPO_PUBLIC_API_URL"
fi
```

- [ ] **Step 3: Provision the lane's database**

Replace the whole `--- 3. the database ---` block with:

```bash
# --- 3. the database ---------------------------------------------------------
# One shared Postgres, one database per lane on it. `npm run db:up` is refused
# from a worktree (scripts/db-up.sh) because compose would start a second
# container; the running one is what every lane uses.
if ! command -v docker > /dev/null 2>&1; then
  echo "  note       docker not on PATH; skipping the database"
elif ! docker ps --format '{{.Image}}' 2>/dev/null | grep -q '^postgres:'; then
  echo "  note       no Postgres running. Start it from the MAIN checkout:"
  echo "               (cd $MAIN && npm run db:up)"
  echo "             then re-run this script to create $(basename "$DATABASE_URL")."
elif [ -d node_modules ]; then
  # Fresh migrate and seed, not a clone of lane 0: a lane starts from the
  # recorded seed with an empty dictionary. `npm run dict:restore` fills it from
  # data/backfill/en-he/dictionary.jsonl when a lane wants words to play with.
  echo "  running    db:migrate for $(basename "$DATABASE_URL")"
  npm run db:migrate > /dev/null || status=1
  echo "  ok         $(basename "$DATABASE_URL") migrated and seeded"
  echo "             dictionary is empty — 'npm run dict:restore' fills it"
else
  echo "  note       skipping the database: node_modules is missing above"
  status=1
fi
```

- [ ] **Step 4: Tell the session which lane it is in**

In `.claude/settings.json`, replace the single `SessionStart` hook command with two. The first is the existing check, extended to cover `.lane`; the second reports the lane.

```json
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "if [ ! -f apps/mobile/.env.local ] || [ ! -d node_modules ] || { [ \"$(cd \"$(git rev-parse --git-common-dir)/..\" && pwd -P)\" != \"$(pwd -P)\" ] && [ ! -f .lane ]; }; then jq -n '{hookSpecificOutput:{hookEventName:\"SessionStart\",additionalContext:\"This worktree is not set up: apps/mobile/.env.local, node_modules or .lane is missing, because git worktree add brings only tracked files. Run ./scripts/setup-worktree.sh before running the app, the tests or the e2e suite. Without .env.local the app throws EXPO_PUBLIC_API_URL is not set at module scope, which surfaces as three misleading expo-router errors. Without .lane every lane-derived command refuses to run.\"}}'; fi",
            "statusMessage": "Checking worktree setup..."
          },
          {
            "type": "command",
            "command": "out=$(bash scripts/lane-env.sh 2>&1) && jq -n --arg out \"$out\" '{hookSpecificOutput:{hookEventName:\"SessionStart\",additionalContext:(\"This checkout is a lane. Its derived environment:\\n\" + $out + \"\\n\\nEvery npm script that starts or tests something already runs through scripts/lane-env.sh, so npm run server, mobile, e2e, test:integration and the db:/dict: scripts all use these values with no arguments. Never hardcode a port or a database name; ADR 0006 forbids it. Other checkouts are running on their own ports at the same time - npm run lane:list shows them.\")}}'",
            "statusMessage": "Reading the lane..."
          }
        ]
      }
    ],
```

- [ ] **Step 5: Verify setup from a real worktree**

```bash
git worktree add -b lane-probe /tmp/lane-probe master
cd /tmp/lane-probe && ./scripts/setup-worktree.sh
```

Expected: it allocates a slot, prints the lane's ports, installs dependencies, writes `.env.local` pointing at the lane's port, and migrates a database named `lang_tutor_lane_probe`. Then:

```bash
cat /tmp/lane-probe/.lane /tmp/lane-probe/apps/mobile/.env.local
cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-15-lanes && npm run lane:list
```

Expected: the listing shows `lang_tutor_lane_probe` as lane `lane_probe` with its branch.

- [ ] **Step 6: Verify it is idempotent, then tear the probe down**

```bash
(cd /tmp/lane-probe && ./scripts/setup-worktree.sh)
(cd /tmp/lane-probe && npm run lane:down)
git worktree remove --force /tmp/lane-probe
npm run lane:list
```

Expected: the second setup run changes nothing and exits 0; `lane:down` drops `lang_tutor_lane_probe`; the final listing no longer shows it.

- [ ] **Step 7: Commit**

```bash
git add scripts/setup-worktree.sh .claude/settings.json
git commit -m "feat: setup-worktree.sh makes a worktree into a lane

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: ADR 0006 and its check

The invariant, recorded so it survives, and the three rules a grep can keep.

**Files:**
- Create: `docs/adr/adr-0006-lanes.md`
- Create: `scripts/check-adr-0006-lanes.sh`

**Interfaces:**
- Consumes: everything built so far; the check reads the tree as it now stands.
- Produces: `scripts/check-adrs.sh` discovers the new script by its name alone. Nothing else needs wiring.

- [ ] **Step 1: Run the conflict scan the create-adr skill requires**

Read every `docs/adr/*.md` and README's Architecture section, then report, before writing anything:

- Any rule in an accepted ADR that cannot hold alongside "every checkout is self-contained", quoted as `ADR NNNN Rx says X; this needs Y`.
- Any prose this decision makes untrue — in particular README's *Running it* section, which tells a reader to run `npm run db:migrate` and `npm run server` with no mention of lanes, and CLAUDE.md's *Worktrees* section, which describes the `db:up` collision as a rule to remember rather than one the tooling enforces.

Expected: no contradiction. ADR 0002's composition-root rule is what the design already follows, and ADR 0004's test topology is untouched. The two stale passages are Task 11's work. Report the scan's result before continuing; if a genuine contradiction appears, stop and raise it rather than resolving it.

- [ ] **Step 2: Write the ADR**

Create `docs/adr/adr-0006-lanes.md`:

```markdown
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
  MockServer namespace, a fixed path outside the checkout, a browser profile, a lock file.
  R1, R2 and R4 catch the forms that exist in this repo today; a new form is not greppable
  in advance, and this rule is what a reviewer applies when a change introduces one.
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
# R1 — a lane-0 port literal outside the owners
grep -rnE "(^|[^0-9])(3001|3002|8081|8082)([^0-9]|$)" \
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
```

- [ ] **Step 3: Write the check script**

Create `scripts/check-adr-0006-lanes.sh`:

```bash
#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0006-lanes.md.
#
# Each rule below is the command printed in that ADR's "How to detect a
# violation" section, verbatim. The two must stay in sync: the ADR is the
# explanation, this file is the enforcement, and a rule that lives in only one
# of them is a rule nobody is keeping.
#
# grep's exit codes run backwards from what this needs — a match means a
# VIOLATION, and finding nothing (exit 1) is the passing case — so nothing here
# relies on exit status, and `set -e` is deliberately absent.
#
# The three files excluded from R1 are excluded by exact name, never by
# directory: lane-env.sh IS the formula, test-lane-env.sh asserts the numbers it
# produces, and this script carries them in its own pattern. Excluding
# scripts/ wholesale would delete the rule.

set -u

cd "$(dirname "$0")/.." || exit 1

status=0

check() {
  rule="$1"
  fn="$2"
  output=$("$fn" 2>/dev/null)
  if [ -n "$output" ]; then
    printf '\n  VIOLATION  %s\n' "$rule" >&2
    printf '%s\n' "$output" | sed 's/^/             /' >&2
    status=1
  else
    printf '  ok         %s\n' "$rule"
  fi
}

OWNERS='^(scripts/lane-env\.sh|scripts/test-lane-env\.sh|scripts/check-adr-0006-lanes\.sh):'

r1() {
  grep -rnE "(^|[^0-9])(3001|3002|8081|8082)([^0-9]|$)" \
    e2e apps/server/tests scripts package.json \
    --include='*.ts' --include='*.sh' --include='*.json' 2>/dev/null \
    | grep -vE "$OWNERS"
}

# A string literal or a URL path, not the word in prose: a comment explaining
# that the e2e database is dropped every run is accurate documentation, not a
# hardcoded address. apps/server/tests/ is outside this rule — the lane tests
# name databases because naming them is their subject.
r2() {
  grep -rnE "['\"\`/]lang_tutor" e2e scripts package.json \
    --include='*.ts' --include='*.sh' --include='*.json' 2>/dev/null \
    | grep -vE "$OWNERS"
}

r3() {
  # db:down is absent on purpose: it stops the shared containers, which is a
  # lane-0 act taking no lane values.
  for key in server mobile e2e test:integration db:up db:migrate db:reseed \
             dict:export dict:restore lane:list lane:down; do
    line=$(grep -E "^    \"$key\": " package.json)
    if [ -z "$line" ]; then
      echo "\"$key\" is missing from package.json scripts"
      continue
    fi
    printf '%s' "$line" | grep -q 'lane-env.sh' || echo "$line"
  done
}

r4_addresses() {
  grep -nE '^export const (API_URL|APP_URL|MOCKSERVER_URL) =' e2e/urls.ts | grep -v requireEnv
}

r4_namespace() {
  grep -n 'E2E_MOCK_NAMESPACE = ' e2e/tests/support/mockServer.ts | grep -v requireEnv
}

r4_tmp() {
  grep -rn '/tmp/' scripts --include='*.sh' | grep -v 'mktemp'
}

echo "Checking the tree against ADR 0006 (lanes)"
echo

check "R1  no lane-0 port literal outside the owners"               r1
check "R2  no lane-0 database name outside the owners"              r2
check "R3  every start-or-test script runs through the wrapper"     r3
check "R4  the e2e addresses come from the environment"             r4_addresses
check "R4  the e2e MockServer namespace comes from the environment" r4_namespace
check "R4  no hardcoded temp path in scripts/"                      r4_tmp

echo
if [ "$status" -ne 0 ]; then
  echo "ADR 0006 violations found. See docs/adr/adr-0006-lanes.md." >&2
fi

exit "$status"
```

- [ ] **Step 4: Run it and confirm it passes on the current tree**

```bash
bash scripts/check-adr-0006-lanes.sh
```

Expected: six `ok` lines, exit 0. If a rule reports a hit, fix the file it names rather than widening the exclusion — that hit is the rule working.

- [ ] **Step 5: Plant a violation of each rule and confirm each one fires**

A check that cannot fire prints nothing, exactly like a check that passes. Prove all six, one at a time, restoring the tree between each:

```bash
# R1 — a port literal
echo "const stray = 'http://localhost:3001';" >> e2e/urls.ts
bash scripts/check-adr-0006-lanes.sh; echo "exit=$?"
git checkout e2e/urls.ts

# R2 — a database name
echo "const stray = 'lang_tutor_e2e';" >> e2e/globalSetup.ts
bash scripts/check-adr-0006-lanes.sh; echo "exit=$?"
git checkout e2e/globalSetup.ts

# R3 — an unwrapped script
npm pkg set scripts.server="npm run dev --workspace apps/server"
bash scripts/check-adr-0006-lanes.sh; echo "exit=$?"
git checkout package.json

# R4 — an address that stops reading the environment
sed -i '' "s/export const APP_URL = requireEnv('E2E_APP_URL');/export const APP_URL = 'http:\/\/localhost:8082';/" e2e/urls.ts
bash scripts/check-adr-0006-lanes.sh; echo "exit=$?"
git checkout e2e/urls.ts

# R4 — a fixed namespace
sed -i '' "s/requireEnv('E2E_MOCK_NAMESPACE')/'e2e'/" e2e/tests/support/mockServer.ts
bash scripts/check-adr-0006-lanes.sh; echo "exit=$?"
git checkout e2e/tests/support/mockServer.ts

# R4 — a hardcoded temp path
echo 'OUT=/tmp/lane-scratch' >> scripts/db-up.sh
bash scripts/check-adr-0006-lanes.sh; echo "exit=$?"
git checkout scripts/db-up.sh
```

Expected: each run reports the planted rule as `VIOLATION` and exits 1; the tree is clean between each. The fourth plant is expected to trip R1 as well as R4, since it writes a port literal — that is two rules agreeing, not a defect.

- [ ] **Step 6: Confirm discovery and a clean tree**

```bash
git status --porcelain
npm run lint:arch
```

Expected: no modified files; `lint:arch` runs six check scripts including the new one, all passing.

- [ ] **Step 7: Commit**

```bash
git add docs/adr/adr-0006-lanes.md scripts/check-adr-0006-lanes.sh
git commit -m "docs: ADR 0006 — every checkout is self-contained, with its check

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Documentation, and the two-lane acceptance run

The scenario that fails today, proved working, and the two documents that tell a reader how to get there.

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Rewrite CLAUDE.md's Worktrees section**

Replace the whole `# Worktrees` section with:

```markdown
# Lanes

Every checkout is a **lane** with ports and databases of its own, so several can run at
once. The main checkout is lane 0 and its values are unchanged: server 3001, Metro 8081,
database `lang_tutor`. Each worktree gets a slot from its `.lane` file and a name from its
branch, and `scripts/lane-env.sh` derives everything else — see
`docs/adr/adr-0006-lanes.md`, which a check script enforces.

Run `./scripts/setup-worktree.sh` in a new worktree before anything else. `git worktree
add` brings tracked files and nothing else, so a new worktree is missing exactly what
`.gitignore` covers — `apps/mobile/.env.local`, `node_modules` and `.lane` — and it has no
database yet. The script is idempotent, and a SessionStart hook says so when it has not
run. Skipping it makes the app throw `EXPO_PUBLIC_API_URL is not set` at module scope,
which surfaces as three misleading expo-router errors about a missing default export.

**Never hardcode a port or a database name.** `npm run server`, `mobile`, `e2e`,
`test:integration` and every `db:`/`dict:` script already run through the wrapper and need
no arguments. `npm run lane:list` shows every lane on the shared Postgres, which of them a
server is answering for, and any database whose worktree is gone.

**`npm run db:up` is refused from a worktree** while another checkout's Postgres holds port
5432: compose derives its project name from the directory, so it would start a second
container and fail. Start it from the main checkout; every lane has its own databases on
that one container.

The main checkout stays on `master`. A branch can only be checked out in one place at a
time, and switching branches under a running server is what lanes exist to avoid.
```

- [ ] **Step 2: Add a "Working in lanes" section to README**

Insert immediately after the `## Running it` section's final paragraph, before `### Environment variables`:

```markdown
### Working in lanes

Several checkouts can run at once. The main checkout is **lane 0** and keeps the values
above. Each worktree is a lane of its own, numbered 1..9, with ports and databases derived
from its slot and branch by `scripts/lane-env.sh`:

| | lane 0 | slot *n* |
|---|---|---|
| server | 3001 | 3001 + 1000·n |
| Metro | 8081 | 8081 + 1000·n |
| e2e server / app | 3002 / 8082 | 3002 / 8082 + 1000·n |
| dev database | `lang_tutor` | `lang_tutor_<branch>` |
| e2e database | `lang_tutor_e2e` | `lang_tutor_e2e_<branch>` |
| test databases | `t_…` | `t_<branch>_…` |

```bash
git worktree add -b my-feature .claude/worktrees/my-feature master
cd .claude/worktrees/my-feature
./scripts/setup-worktree.sh   # slot, node_modules, .env.local, its own database
npm run server                # on this lane's port
npm run dict:restore          # optional: the checked-in dictionary, ~2 minutes
```

Every script that starts or tests something already runs through the wrapper, so none of
them take a port or a database argument. `npm run lane:list` shows what exists:

```
lang_tutor                     lane main         :3001 serving
lang_tutor_my_feature          lane my_feature   branch my-feature  |  :4001 idle
```

`/health` names the lane, database and port that answered, so a probe can never be
mistaken for another lane's server. Removing a worktree is `npm run lane:down` from inside
it, then `git worktree remove`.

One shared Postgres and one shared MockServer serve every lane; start them from the main
checkout with `npm run db:up`, which is refused elsewhere.
```

- [ ] **Step 3: Update the README passage that tells a reader to copy `.env.local`**

In `## Running it`, replace the `cp apps/mobile/.env.example apps/mobile/.env.local` line's surrounding paragraph so it no longer implies copying is how a worktree gets one:

```markdown
Docker, then the database, then the server, then the app. The mobile app reads its
server URL from `apps/mobile/.env.local`, which Expo auto-loads and git ignores (only
`.env.example` is committed). In the main checkout, create it by hand; in a worktree,
`./scripts/setup-worktree.sh` generates it pointing at that lane's own server.
```

- [ ] **Step 4: Run the whole suite**

```bash
npm run lint:arch
npm run test:lanes
npm run typecheck
npm test
npm run test:integration
npm run e2e
```

Expected: all six pass.

- [ ] **Step 5: The two-lane acceptance run**

This is the scenario that fails on `master` and the reason the phase exists. From the main checkout, with its server already running:

```bash
cd /Users/victorprp/git/lang-tutor
npm run server &            # lane 0, port 3001
cd .claude/worktrees/phase-15-lanes
./scripts/setup-worktree.sh
npm run server &            # this lane, port 4001
sleep 5
curl -s localhost:3001/health; echo
curl -s localhost:4001/health; echo
```

Expected: two servers, each naming its own lane and database, neither having failed to bind.

Then, with both still running:

```bash
# in the main checkout
(cd /Users/victorprp/git/lang-tutor && npm run test:integration) &
# in this worktree, at the same time
npm run test:integration
wait
```

Expected: both suites pass. Before this phase the second sweep would have dropped the first's templates mid-run.

Finally, e2e in this lane while lane 0's dev server is up:

```bash
npm run e2e
```

Expected: PASS, on this lane's e2e port and database.

Stop the two servers when done:

```bash
kill %1 %2
```

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: describe lanes in the README and CLAUDE.md

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: §1 lane identity and derivation → Task 1; §2 provisioning → Tasks 4, 5, 9; §3 consumers → Tasks 3, 6, 7, 8, 9; §4 identification → Tasks 3, 4, 5; §5 ADR 0006 → Task 10; §6 testing → Tasks 1, 6, 11; rollout → Task 11's acceptance run.

**Deviations from the spec, deliberate:**

- The spec listed `lane:list` and `lane:down` as reading `git worktree list`. They read the database stamps instead, which carry the worktree path and branch already. That keeps `src/db/lanes.ts` to pure SQL, which ADR 0001 requires of the persistence layer, and removes a `git` subprocess from a composition root.
- The database comment gains a `port` field, which the spec did not list. Without it `lane:list` cannot probe, and the probe is what makes "which lane answered?" checkable rather than merely visible.
- `scripts/db-up.sh` is new and was not in the spec's file list. The `db:up` guard needs a shell body somewhere, and putting it in `package.json` would have put a compose invocation and its literals back into the file ADR 0006 R1 checks.
- The e2e server's port on lane 0 becomes 3002, which the spec states, and `E2E_APP_PORT` and `MOCKSERVER_URL` are exported too — the spec's table named neither, and `expo serve` needs the first while the e2e suite needs the second.
- The spec said e2e would read its values "with today's values as defaults". The plan gives it **no** defaults: it is always started through the wrapper, so a default could only ever be a wrong answer nobody noticed, and removing them is also what lets ADR 0006 R2 cover `e2e/` with no exclusions.

**Type consistency.** `LaneStamp` is produced by `laneStampFrom` and consumed by `ensureDatabase` and `formatLaneComment` with the same five fields throughout. `ServerIdentity` has the same three fields in `composition.ts`, `index.ts`, `fakes.ts`, `serverDeps.ts` and both `app.test.ts` cases. `dbPrefix()` is the single reader of `TEST_DB_PREFIX`, used by `templateName`, `testDbName` and `sweepPattern`. `requireEnv` is defined in `e2e/urls.ts` and imported by `globalSetup.ts` and `mockServer.ts`.

**Placeholder scan.** No `TBD`, no "handle edge cases", no "similar to Task N". Every code step carries the code and every verification step carries the command and its expected output.
