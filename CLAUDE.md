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

# Worktrees

`git worktree add` brings tracked files and nothing else, so a new worktree is missing
exactly what `.gitignore` covers — `apps/mobile/.env.local` and `node_modules`. Run
`./scripts/setup-worktree.sh` before running the app, the tests or the e2e suite; it is
idempotent, and a SessionStart hook (`.claude/settings.json`) says so when either is
absent. Skipping it makes the app throw `EXPO_PUBLIC_API_URL is not set` at module scope,
which surfaces as three misleading expo-router errors about a missing default export.

**Never run `npm run db:up` from a worktree** while another checkout's Postgres holds port
5432: compose derives its project name from the directory, so it starts a second container
and fails. Reuse the running one — integration tests clone a per-test database off it
either way.
