# Lanes: parallel checkouts that cannot collide — design

- **Status:** design approved, ready to plan.
- **Date:** 2026-09-16
- **Relationship to earlier work:** `scripts/setup-worktree.sh` (the `chore/worktree-setup`
  branch) made a worktree *runnable* — dependencies, the mobile env file, a warning about
  the shared Postgres. It did not make one *independent*: every checkout still defaults to
  the same ports, the same three databases and the same test-database names, so a second
  checkout can only run what the first one is not running. Phase 14 (`nightly-qa/`) worked
  around this for one consumer with hand-picked ports and a database of its own. This design
  makes the same independence the default for every checkout, with one mechanism.

## Summary

A **lane** is a checkout. The main checkout is lane 0 and keeps every value it has today.
Every other worktree is a numbered lane with a name taken from its branch, and one script,
`scripts/lane-env.sh`, derives every port, database name and namespace the lane uses from
that number and name. Every npm script that starts or tests something runs through it;
Node code keeps reading `process.env` and nothing else. The server reports which lane it
is on `/health`, every lane database carries a comment naming its worktree and branch, and
`npm run lane:list` shows the whole picture. ADR 0006 records the invariant and a check
script enforces the part of it a grep can see.

The result: several Claude sessions, each in its own worktree on its own feature, each
running its own server, Metro, integration suite and e2e suite at the same time, while the
developer plays with any of them, and none of them can reach another's state.

## What blocks parallel work today

Found by exploration on 2026-09-16, each verified by reading or by running:

- **One set of addresses.** Server 3001, Metro 8081, e2e app 8082. The server honours
  `PORT` (verified: a second instance on 3002 against a cloned database came up), but
  `e2e/urls.ts` hardcodes 3001 and 8082 and `apps/mobile/.env.local` hardcodes 3001.
- **A healthy port proves nothing.** Verified: a second `npm run server` dies with
  `EADDRINUSE`, tsx watch stays alive as a process, and `/health` on 3001 keeps answering
  `{"ok":true}` — from the *other* server. An agent that polls health then tests its change
  against someone else's server, database and provider. `playwright.config.ts` codifies the
  same trap: `reuseExistingServer: !CI` on the API entry attaches `npm run e2e` to whatever
  holds 3001, which locally is the dev server on `lang_tutor` with real Gemini.
- **One schema stream for three hand-named databases.** The server does not migrate on
  boot; `db:migrate` migrates whatever `DATABASE_URL` says, default `lang_tutor`. A branch's
  new migration lands in the shared database, an older branch's server runs against it,
  and drizzle's migrator applies only what is missing, so nobody is told. Migrations here
  truncate (0003, 0005), so a cross-branch migration can also wipe another lane's data.
- **Integration runs from two checkouts kill each other.** `tests/support/globalSetup.ts`
  sweeps every `t_test_*` and `t_tmpl_*` database with `drop ... with (force)`, and template
  names are `t_tmpl_<worker>` in every checkout. A run starting in checkout B mid-run in A
  drops A's live templates.
- **The mobile app silently targets lane 0.** `EXPO_PUBLIC_API_URL` is inlined at build
  time from `.env.local`, which names port 3001, and `setup-worktree.sh` copies that file
  verbatim into a worktree.
- **`lang_tutor_e2e` is dropped and recreated per run** and e2e's MockServer namespace is
  the fixed string `e2e`, so two e2e runs cannot overlap.
- **A worktree isolates files only.** Not ports, not database names, not env, not the
  Docker project. Git isolation was never the collision, which is why worktrees have felt
  like no benefit.

## Goals

- Any checkout can run `npm run server`, `npm run mobile`, `npm run test:integration` and
  `npm run e2e` while every other checkout is doing the same, with no coordination.
- Nothing a checkout runs can be mistaken for another checkout's: a port, a health
  response, a database name and a database comment all say which lane they belong to.
- The main checkout changes nothing: same ports, same databases, same commands.
- One formula, in one file, enforced by an ADR check.

## Non-goals

- Nightly QA (`nightly-qa/`) stays as it is. In CI it has a runner of its own, so lanes
  buy it nothing; locally its reserved ports already coexist with a dev loop. The formula
  simply never lands on 3101 or 8092.
- A Docker stack per lane. Postgres and MockServer stay shared, for the reason
  `docker-compose.yml` already gives: they are behaviour-free and namespaced per caller.
- Windows.

## The workflow this assumes

The main checkout, `/Users/victorprp/git/lang-tutor`, stays on `master` and is lane 0.
Feature work happens in worktrees, one per task, each on its own branch, each in its own
Claude session (in VS Code, one window per worktree directory). Claude's worktree tool
creates them under `.claude/worktrees/`, which is already gitignored; a hand-made
`git worktree add -b <branch> <dir> master` is equivalent. Merging into `master` happens
from the main checkout. Removing a worktree is `npm run lane:down` then
`git worktree remove`.

This is a convention, not something a script can enforce; ADR 0006 says so explicitly.

## Design

### 1. Lane identity and derivation

**Lane 0** is the main checkout — the one whose `.git` is a directory rather than a file —
whatever branch it holds. Its values are today's values.

Every other worktree has a **slot** and a **name**:

- The **slot** is an integer from 1 to 9 in a gitignored `.lane` file in the worktree
  root. `setup-worktree.sh` allocates the lowest integer no other worktree's `.lane` holds
  (found via `git worktree list`). A tenth worktree is refused with the list of the nine.
- The **name** is the current branch slugged to `[a-z0-9_]`, capped at 24 characters with a
  6-character hash suffix when truncated, so every identifier derived from it fits
  Postgres's 63-byte limit. A detached HEAD is refused. The slugs `test` and `tmpl` are
  refused: `t_test_tmpl_1` would match lane 0's sweep pattern.

From those two, the formula:

| Value | Lane 0 | Lane with slot *n* and name *name* |
|---|---|---|
| `LANE` | `main` | *name* |
| `PORT` (dev server) | 3001 | 3001 + 1000·n |
| `E2E_API_URL` port | 3002 | 3002 + 1000·n |
| `METRO_PORT` | 8081 | 8081 + 1000·n |
| `E2E_APP_URL` port | 8082 | 8082 + 1000·n |
| `DATABASE_URL` database | `lang_tutor` | `lang_tutor_<name>` |
| `E2E_DATABASE_URL` database | `lang_tutor_e2e` | `lang_tutor_e2e_<name>` |
| `TEST_DB_PREFIX` | `t_` | `t_<name>_` |
| `E2E_MOCK_NAMESPACE` | `e2e` | `e2e_<name>` |
| `EXPO_PUBLIC_API_URL` | `http://<host>:3001` | `http://<host>:<PORT>` |

Slot 1 is therefore 4001, 4002, 9081, 9082. A thousand per lane is easy to hold in your
head, and no slot reaches nightly QA's 3101 or 8092.

Test databases become `t_<name>_tmpl_<worker>` and `t_<name>_test_<slug>_<hex>`; lane 0
keeps the bare `t_` prefix and its existing names.

`<host>` in `EXPO_PUBLIC_API_URL` is `LANE_API_HOST` if set, else the host in the main
checkout's `apps/mobile/.env.local`, else `localhost` — so a phone on the LAN reaches any
lane through that lane's port.

**`scripts/lane-env.sh`** owns the formula and nothing else does. Used as
`lane-env.sh <command...>` it exports every variable in the table plus `LANE_SLOT`, then
execs the command. Used with no arguments it prints them as `KEY=value` lines, which the
SessionStart hook and `lane:list` read. Any variable already set in the environment wins
over the derived value, so an ad-hoc override, CI, and nightly QA keep working unchanged.

The one dev-server change from today: the e2e suite gets a port of its own (3002 on lane
0) rather than sharing the dev server's. See §3.

### 2. Provisioning and cleanup

`setup-worktree.sh` is extended, not replaced — CLAUDE.md and the SessionStart hook already
name it. Under lane 0 it does what it does today. In a worktree it runs four idempotent
steps:

1. **Allocate the slot** and write `.lane`, unless the file exists.
2. **Install dependencies**, as today (roughly 700 MB per worktree; the cap of nine is also
   a disk budget).
3. **Generate `apps/mobile/.env.local`** from the formula — never copied. It is rewritten
   whenever its `EXPO_PUBLIC_API_URL` disagrees with what `lane-env.sh` derives, so a stale
   file cannot point a lane's app at another lane's server.
4. **Create the dev database** by running `db:migrate` under the lane env. `db/cli.ts`
   gains one capability: when the database named by `DATABASE_URL` does not exist, it
   connects to the `postgres` maintenance database on the same host, creates it, and then
   migrates and seeds as it already does — a fresh migrate plus the recorded seed, not a
   clone of lane 0. The same path writes and refreshes the database comment (§4).
   `npm run dict:restore` under the lane env fills the dictionary from the checked-in
   dataset when a lane wants words to play with.

The e2e database and the test databases need no provisioning step: `e2e/globalSetup.ts`
and the integration harness already create theirs per run, now under lane-derived names.

Two new root npm scripts complete the lifecycle. Both are flags on `db/cli.ts`
(`--lane-list`, `--lane-down <name>`), run under `lane-env.sh`: that file is already the
process composition root for database maintenance, and ADR 0002's own comment there
prefers a flag to a fourth entry point.

- **`npm run lane:list`** prints one row per lane: name, slot, branch, path, ports, which
  of its databases exist, and whether a server answers on its port and which lane it
  claims to be. It joins `git worktree list` with `pg_database` and the database comments.
  A database whose worktree is gone is shown as an orphan with the command to drop it.
- **`npm run lane:down [name]`** drops the lane's dev, e2e and `t_<name>_*` databases with
  force. It refuses lane 0 and never removes the worktree; the order is `lane:down`, then
  `git worktree remove`.

Docker stays shared and unchanged. `npm run db:up` gains a guard that refuses to run from
a non-zero lane while a Postgres container is up — the documented trap becomes an error.
Connections are not a concern: Postgres allows 100, a server pool takes 5, a jest run a
handful per worker.

### 3. Consumers

Scripts wire; code reads. Every root npm script that starts or tests something runs through
`lane-env.sh`; Node code reads `process.env` and its shape does not change.

- **Server**: no code change beyond §4. `npm run server` becomes
  `lane-env.sh npm run dev -w apps/server`.
- **Mobile**: `npm run mobile` becomes `lane-env.sh expo start --port $METRO_PORT`. The
  generated `.env.local` carries the lane's API URL and the wrapper exports the same value,
  which Expo prefers over the file, so the two cannot disagree.
- **Integration tests**: `tests/support/dbNames.ts` reads `TEST_DB_PREFIX` (default `t_`)
  and builds template and test names from it. The sweep in `globalSetup.ts` derives its
  regex from the same prefix, so a lane only ever drops its own databases.
  `npm run test:integration` and `test:all` run through the wrapper. Unit tests are
  untouched.
- **e2e**: `urls.ts` and `globalSetup.ts` read `E2E_API_URL`, `E2E_APP_URL`,
  `E2E_DATABASE_URL` and `E2E_MOCK_NAMESPACE` from env, with today's values as defaults.
  The e2e server listens on `E2E_API_URL`'s port, not the dev server's, and
  `reuseExistingServer` becomes `false` on both `webServer` entries. Today's reuse is
  exactly the trap in *What blocks parallel work today*; with a port of its own, e2e never
  collides with the lane's dev loop and never attaches to the wrong server. CI already ran
  with reuse off and is unaffected.
- **Database CLI**: `db:migrate`, `db:reseed`, `dict:export`, `dict:restore` run through
  the wrapper, so they hit the lane's database by default.
- **Hooks**: SessionStart runs `lane-env.sh` with no arguments and puts the lane's name,
  branch, ports and database into its context, beside the existing missing-setup warning,
  which now also covers a missing `.lane` and a stale `.env.local`. The Stop hook is
  unchanged.
- **Docs**: README gains a "Working in lanes" section; CLAUDE.md's *Worktrees* section is
  rewritten around lanes.

### 4. Identification

Two additions make "who answered?" unambiguous.

- **`/health` names its lane.** The response becomes `{ ok, lane, database, port }`, where
  `database` is the name only, never the URL. `loadConfig` reads `LANE` (default `main`)
  and the health handler reports it with the database name parsed from the config — a
  small change inside the existing composition root plus a schema addition to the OpenAPI
  document under ADR 0003.
- **Database comments carry the lane.** Every lane database gets
  `lane <name> | slot <n> | worktree <path> | branch <branch> | created <iso>` via
  `COMMENT ON DATABASE`, written when created and refreshed on every migrate, visible with
  `\l+` and joined by `lane:list`. This is the pattern `tests/support/testDb.ts` already
  uses for per-test databases.

No check is added to e2e itself: with reuse off and a port of its own, an occupied port
fails the run loudly at startup, the same guard the app entry already relies on.

### 5. ADR 0006 and its check

Written with the `create-adr` skill. The decision it records is an invariant, not a
mechanism, so that a change which respects the grep rules but breaks parallel work still
reads as a violation:

> **Every checkout is self-contained.** Nothing a checkout runs, starts or tests may read
> or write state another checkout could be using at the same time. The only shared things
> are the Docker services, shared by design because they are behaviour-free and namespaced
> per caller.

Three enforceable consequences, one script, `scripts/check-adr-0006-lanes.sh`, discovered
by `check-adrs.sh` like the others:

1. **No literal address outside the owners.** Under `e2e/`, `apps/server/tests/`,
   `scripts/` and the root `package.json`, a literal `localhost:<port>`, a bare `3001`,
   `3002`, `8081` or `8082`, or a `lang_tutor` database name is a violation. The owners are
   `scripts/lane-env.sh` (the formula) and `apps/server/src/config.ts` (lane 0's defaults,
   which is where a composition root's defaults belong under ADR 0002).
   `docker-compose.yml`, `nightly-qa/`, README and `docs/` are outside the rule.
2. **Wrapped scripts stay wrapped.** The root `package.json` scripts `server`, `mobile`,
   `e2e`, `test:integration`, `test:all` and every `db:` and `dict:` script must invoke
   `lane-env.sh`. A later script that starts a process without the wrapper is exactly how
   a lane lands on lane 0's port again.
3. **Any new shared resource is derived from the lane** — a port, a database, a MockServer
   namespace, a fixed path outside the checkout, a browser profile. The check greps for a
   fixed MockServer namespace literal in `e2e/` and for absolute paths under `/tmp` in
   `scripts/`, the two forms that exist today. What the grep cannot see is what the
   invariant text is for.

The ADR also states the workflow assumption (*The workflow this assumes*, above) and says
plainly that no script checks it.

As CLAUDE.md requires, each rule is proved by planting a violation first — a hard-coded
`localhost:3001` in `e2e/urls.ts`, an unwrapped `server` script, a literal `/e2e/` path in
an e2e helper — confirming the script reports each, then removing them.

### 6. Testing

- **The formula**: `scripts/test-lane-env.sh` builds a throwaway git repository with
  worktrees in a temp directory and asserts what `lane-env.sh` prints: lane 0 in the main
  checkout, lowest-free slot allocation, the port arithmetic, slug truncation with the hash
  suffix, refusal of a detached HEAD and of the `test`/`tmpl` slugs, the cap at nine, and
  that a preset variable wins. No database. Runs as `npm run test:lanes`, in CI beside
  `lint:arch`.
- **Test-database prefixing** is proven in the integration suite itself: CI runs
  `test:integration` with `TEST_DB_PREFIX=t_ci_`, and the existing per-test-isolation test
  asserts its database name starts with the prefix. A silently ignored prefix fails there.
- **`/health`**: a unit test for the handler with `LANE` set and unset, the existing
  integration coverage, and the OpenAPI document updated for the new fields.
- **e2e** runs in CI as today, on lane 0's e2e port.
- **Acceptance, by hand, once**: two lanes side by side — dev servers on 3001 and 4001 each
  reporting its own lane on `/health`; `npm run test:integration` in both at the same time,
  both green; `npm run e2e` in lane 1 while lane 0's dev server is up. This is the scenario
  that fails today and the one the phase exists for.

## Rollout

1. Finish and merge `phase-14-nightly-qa`; switch the main checkout to `master`.
2. Build phase 15 in the first worktree. Until `lane-env.sh` exists that worktree is run
   by hand with `PORT`, `DATABASE_URL` and `TEST_DB_PREFIX` overrides; once the script
   lands it becomes lane 1 like any other.
3. The 210 stale `t_test_*` databases (1.6 GB) are swept by lane 0's next integration run,
   as today.

## Files touched

- New: `scripts/lane-env.sh`, `scripts/test-lane-env.sh`,
  `scripts/check-adr-0006-lanes.sh`, `docs/adr/adr-0006-lanes.md`.
- Changed: `scripts/setup-worktree.sh`, root `package.json`, `.gitignore` (`.lane`),
  `.claude/settings.json` (SessionStart), `apps/server/src/config.ts`, the health route and
  its OpenAPI schema, `apps/server/src/db/cli.ts`, `apps/server/tests/support/dbNames.ts`
  and `globalSetup.ts`, `e2e/urls.ts`, `e2e/globalSetup.ts`, `e2e/playwright.config.ts`,
  `e2e/tests/support/mockServer.ts`, `.github/workflows/*` (prefix and `test:lanes`),
  README, CLAUDE.md.
- Untouched: `docker-compose.yml`, `nightly-qa/`, `apps/mobile/src`.
