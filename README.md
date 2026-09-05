# lang-tutor

[![CI](https://github.com/victor-prp/lang-tutor/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/victor-prp/lang-tutor/actions/workflows/ci.yml)

A language-learning app for Hebrew speakers memorising English words and phrases.

Phase 1 ran entirely on mock data with a single multiple-choice question type. Phase 2
adds a server: it creates sessions, tracks progress, scores answers, and logs each
completed session — all in memory, no database yet. The learner-facing app is unchanged.

- Phase 1: [design](docs/superpowers/specs/2026-08-24-lang-tutor-phase-1-design.md) · [plan](docs/superpowers/plans/2026-08-24-lang-tutor-phase-1.md)
- Phase 2: [design](docs/superpowers/specs/2026-08-26-lang-tutor-phase-2-design.md) · [plan](docs/superpowers/plans/2026-08-26-lang-tutor-phase-2.md)
- Phase 3: [design](docs/superpowers/specs/2026-08-29-lang-tutor-phase-3-ci-design.md) · [plan](docs/superpowers/plans/2026-08-29-lang-tutor-phase-3-ci.md)

## Layout

An npm-workspace monorepo.

| Path | What it is |
|---|---|
| `packages/core` | `@lang-tutor/core` — the API contract (`api/`), quiz rules (`domain/`), internal helpers (`utils/`). No runtime dependencies. Consumed as TypeScript source, so there is no build step. |
| `apps/mobile` | The Expo app. Screens, components, theme, Hebrew copy, and the API client. |
| `apps/server` | A Hono server on `@hono/node-server`. In-memory session state — no database. Owns the question pool and the quiz's progress; the app talks to it over HTTP. Also consumed as TypeScript source via `tsx`, no build step. |

`utils/` is not in core's `exports` map, so it is unreachable from either app by
design. Anything a consumer needs comes from `@lang-tutor/core/api` (types) or
`@lang-tutor/core/domain` (rules) — both `apps/mobile` and `apps/server` import them.

## Running it

Two processes: the server, then the app. The mobile app reads its server URL from
`apps/mobile/.env.local`, which Expo auto-loads and git ignores (only `.env.example` is
committed) — create it before the first run.

```bash
npm install                                        # from the repo root — it owns dependency resolution
cp apps/mobile/.env.example apps/mobile/.env.local  # EXPO_PUBLIC_API_URL=http://localhost:3001, works as-is below
npm run server                                      # terminal 1 — binds 0.0.0.0:3001 by default
npm run mobile                                      # terminal 2
```

Then press `w` for the browser, or scan the QR code with Expo Go on a phone. The
interface is Hebrew and right-to-left; browser and native RTL are not identical, so
confirm layout on a real device.

**Testing on a physical device:** the phone needs a real IP to reach the server —
`localhost` only works for the web target and simulators, which share the dev machine's
network namespace. Edit the `apps/mobile/.env.local` created above:

```bash
# edit apps/mobile/.env.local: set EXPO_PUBLIC_API_URL to your dev machine's LAN IP
# (macOS: ipconfig getifaddr en0), then restart `npm run mobile`
```

Phone and dev machine must be on the same Wi-Fi network.

## Browsing the database

Postgres has no cross-database `USE` — a connection is bound to one database for its
whole lifetime, so a GUI client like the SQLTools VS Code extension needs one
connection entry per database, not a single connection that lists them all (this is a
longstanding [SQLTools limitation](https://github.com/mtxr/vscode-sqltools/discussions/760),
not something this repo's config controls). A connection with no `database` field set
falls back to the `postgres` maintenance database — that is one specific database, not
"all of them." `.vscode/settings.json` already defines a dedicated connection for
`lang_tutor`.

## Checks

```bash
npm test          # every workspace, including apps/server's real-HTTP integration test
npm run typecheck # every workspace
```

## Continuous integration

Every push, on every branch, runs both of the above plus the end-to-end suite below on GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) as three parallel jobs:

| Job | Runs | Roughly |
|---|---|---|
| `typecheck` | `npm run typecheck` | 1 min |
| `test` | `npm test` | 1-2 min |
| `e2e` | `npm run e2e` — the Playwright suite described below | 4-5 min |

The jobs are independent, so a red `e2e` beside a green `typecheck` and `test` tells you
the app broke, not that the code stopped compiling. A failing `e2e` run uploads a
Playwright trace as a `playwright-traces` artifact; download it and open it with
`npx playwright show-trace` rather than trying to reproduce the failure locally.

Pushing again cancels the previous run for that branch.

These three context names — `typecheck`, `test`, `e2e` — are what a branch-protection
rule on `master` must list to gate merges on CI. No such rule is configured yet; adding
one is a repository setting rather than a change to this repo.

One caveat before making them required: a pull request from a **fork** produces no check
runs, because `on: push` only fires for branches in this repository. Requiring these
contexts would leave such a PR permanently unmergeable. Add a `pull_request` trigger to
the workflow first if outside contributions ever become real.

The Node version comes from `.nvmrc`, which is also what `nvm use` reads — keep local and
CI on the same major version by changing that one file.

## End-to-end test

One Playwright test drives a real Chromium through a complete ten-question session against
the real server, asserting the score matches the answers given.

```bash
npx playwright install chromium   # one time per machine, ~150MB
npm run e2e
```

It needs no servers running first — Playwright starts both itself: `apps/server`, and a
static web export of the app served on port 8082. It builds that export on every run
(~9s), which is deliberate: **the Metro dev server ignores an injected
`EXPO_PUBLIC_API_URL`** (Metro compiles the value in from `.env.local` instead), so a
static export is the only way to reliably point the app at the local test server. Your
`apps/mobile/.env.local` is never read or modified by the suite, so the Expo Go device
workflow above is unaffected.

`npm test` deliberately does **not** run this — the workspace's script is named `e2e`, not
`test`, to keep the unit loop fast.

Design and plan:
[design](docs/superpowers/specs/2026-08-26-lang-tutor-e2e-testing-design.md) ·
[plan](docs/superpowers/plans/2026-08-27-lang-tutor-e2e-testing.md)
