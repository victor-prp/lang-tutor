# Architecture decisions

Before designing or implementing anything under `apps/server` or `apps/mobile`, read the
ADRs in `docs/adr/` — each one is a binding constraint, not a suggestion. A Stop hook
(`.claude/settings.json`) already re-runs `scripts/check-adrs.sh` once per turn, when a
turn touched files under those trees, and CI enforces the same script (also runnable as
`npm run lint:arch`) — so a violation surfaces at the end of the turn rather than at
review time. `check-adrs.sh` discovers every `scripts/check-adr-*.sh` automatically, so
adding a new ADR never means updating this wiring.

When adding a check to any `scripts/check-adr-*.sh`, plant a violation of the rule first
and confirm the script reports it. A check that cannot fire prints nothing, exactly like a
check that passes, so "it printed nothing" is not evidence on its own.

Use the `create-adr` skill when a new structural decision needs recording.

# Prompt evals

`apps/server/tests/eval/` is a fourth test bucket, run by `npm run eval`, and the only
code here that calls a real language model. Nothing in it is named `*.test.ts`, which is
what keeps both Jest projects off it, and it is part of neither `npm test` nor
`npm run test:all` — a real network call belongs in neither. CI runs it as its own
`test-eval` job, in parallel with the rest. It needs `GEMINI_API_KEY` and `GEMINI_MODEL`,
and refuses to run against MockServer.

Because it calls a third party, `test-eval` is the one job that can go red with nothing
wrong in the diff — a model update alone will do it. Read the run's `eval-report` artifact
before assuming the commit broke something, and never answer a tier 2 drop by lowering
`TIER2_THRESHOLD`.

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

Retire a finished lane with **`npm run lane:clean`** from the main checkout. It prints a
plan and changes nothing until given `--yes`, and it skips three kinds of worktree: locked
(a live session holds it), not merged into `origin/master`, and branches with no commits of
their own. For each lane it does clean, it drops the databases *before* removing the
worktree — the only order in which `lane:down` can still find them.

**`npm run db:up` is refused from a worktree** while another checkout's Postgres holds port
5432: compose derives its project name from the directory, so it would start a second
container and fail. Start it from the main checkout; every lane has its own databases on
that one container.

The main checkout stays on `master`. A branch can only be checked out in one place at a
time, and switching branches under a running server is what lanes exist to avoid.
