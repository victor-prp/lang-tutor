# lang-tutor Phase 3 Design: Continuous Integration

**Goal:** Every push to every branch runs the repo's full check suite on GitHub Actions —
typecheck, unit and integration tests, and the Playwright end-to-end test — as three
parallel jobs whose names can be required by branch protection on `master`.

**Relationship to earlier phases:** Phases 1 and 2 built the app and the server; the
[E2E phase](2026-08-26-lang-tutor-e2e-testing-design.md) added the browser test. All of
it runs only when someone remembers to run it. This phase makes the machine remember.

## Scope

In scope:

- One GitHub Actions workflow, `.github/workflows/ci.yml`, running `typecheck`, `test`
  and `e2e` on push.
- Pinning the Node version the repo builds against.
- Documenting CI in the README.

Out of scope, each deferred deliberately:

| Excluded | Why |
|---|---|
| Lint | `apps/mobile` has an `expo lint` script but no committed ESLint config, and no other workspace has one. Making lint real means choosing rules and fixing the violations they surface — a change to the code, not to CI. Its own phase. |
| Deployment (CD) | Needs a hosting decision for both the Hono server and the web export, plus secrets and env config. The server's in-memory session store is also a genuine obstacle to running more than one instance. This phase delivers the CI half only; the branch is named `phase-3-ci` to match. |
| Node / OS matrix | One app, one runtime, one target. A matrix would multiply cost to test a portability claim nobody is making. |
| Splitting the Expo web export into its own job | See "Rejected: a separate build job" below. |

## Trigger

```yaml
on: push
```

No branch filter — every branch, including `master`. This is the literal requirement:
checks run when a branch is pushed, before any pull request exists.

**No `pull_request` trigger.** For branches in this repo, `push` already fires on every
commit a PR would contain, so adding `pull_request` would run the entire suite twice for
every PR. Push-event check runs attach to the head commit and satisfy branch-protection
required-status-checks exactly as pull-request-event runs do. The one thing `push` cannot
cover is a PR from a fork, whose commits never reach this repo's branches — add
`pull_request` if and when outside contributions become real.

**Concurrency.** Runs are grouped per branch with `cancel-in-progress: true`:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Pushing twice in quick succession cancels the superseded run rather than queueing two
full E2E runs. The result of a run against a commit that is no longer the branch tip is
never interesting.

## Jobs

Three jobs on `ubuntu-latest`, no `needs:` between them, so all three start at once.

```
push ──┬─► typecheck    npm run typecheck              ~1 min
       ├─► test         npm test                       ~1-2 min
       └─► e2e          npx playwright test            ~4-5 min
```

Wall clock is the slowest job, not the sum. Three jobs rather than one or two because the
failure report is then unambiguous at a glance: a red `e2e` next to a green `typecheck`
and `test` says "the app is broken", while a red `typecheck` says "the code does not
compile". The cost is two extra `npm ci` runs, which the npm cache makes cheap.

### Shared preamble

Every job begins identically:

1. `actions/checkout`
2. `actions/setup-node` with `node-version-file: .nvmrc` and `cache: 'npm'`
3. `npm ci` at the repo root

`npm ci` runs at the root because the root `package.json` owns dependency resolution for
all four workspaces — the same reason the README tells developers to install from there.
`cache: 'npm'` keys the download cache on `package-lock.json`, so an unchanged lockfile
skips the network for every dependency.

### `typecheck`

```yaml
- run: npm run typecheck
```

Which fans out to `tsc --noEmit` in `packages/core`, `apps/server`, `apps/mobile` and
`e2e` via `--workspaces --if-present`.

### `test`

```yaml
- run: npm test
```

Jest in `packages/core`, `apps/server` (including its real-HTTP integration test, which
binds a socket on the runner) and `apps/mobile` under `jest-expo`. The `e2e` workspace has
no `test` script, so `--if-present` skips it — the E2E suite belongs to the job below, and
naming its script `e2e` rather than `test` is what keeps the two apart. That naming
decision was made in the E2E phase to keep the local unit loop fast; CI inherits the
benefit for free.

### `e2e`

```yaml
- uses: actions/cache          # ~/.cache/ms-playwright, keyed on the Playwright version
- run: npx playwright install --with-deps chromium
- run: npm run e2e
- uses: actions/upload-artifact  # e2e/test-results/, if: failure()
```

Three things here are not obvious:

- **`--with-deps`** installs the system libraries Chromium needs. GitHub's Ubuntu runners
  do not ship them, and without this the browser fails to launch with a shared-library
  error rather than anything resembling a test failure.
- **The browser cache** is keyed on the resolved Playwright version (1.62.1 today), not on
  the lockfile hash: browser binaries change only when Playwright does. A hit turns a
  ~150MB download into a directory restore. `--with-deps` still runs on a hit — the apt
  packages are not part of the cached directory.
- **Artifacts on failure only.** `playwright.config.ts` already sets
  `trace: 'retain-on-failure'`, so a passing run leaves nothing worth uploading and a
  failing one leaves a trace that can be replayed locally with `npx playwright show-trace`.
  Guarding the upload with `if: failure()` keeps green runs from paying for it.

The job runs `npm run e2e` — the same command the README documents for developers. Nothing
about the test's behaviour is special-cased for CI beyond what the suite already handles
itself, below.

## What the E2E suite already does for CI

`e2e/playwright.config.ts` requires **no changes**. GitHub Actions sets `CI=true` on every
runner, and the config already branches on it in the two places that matter:

| Setting | Effect under `CI=true` | Why it is right |
|---|---|---|
| `forbidOnly: !!process.env.CI` | A stray `test.only` fails the run | Prevents a debugging leftover from silently reducing the suite to one test on `master` |
| `reuseExistingServer: !process.env.CI` (server entry) | Always starts a fresh server | On a clean runner there is nothing to reuse; disabling reuse removes an attach-to-something-unexpected failure mode |

The web-export entry sets `reuseExistingServer: false` unconditionally, which is already
the CI-correct value. Both servers are started and torn down by Playwright itself, so the
job needs no service containers and no background-process management.

The config's 300-second timeout on the export entry matters more in CI than locally: the
runner's Metro cache is always cold, so the ~9s warm export the README quotes will be
substantially slower on every run. This is expected, not a regression to chase.

## Repository changes outside the workflow

Two, both small:

- **`.nvmrc` containing `22`.** Nothing pins the Node version today. `setup-node` needs a
  source of truth, and a file at the root serves developers (`nvm use`) as well as CI —
  better than a version literal buried in the workflow that drifts from what anyone
  actually runs. 22 matches the version in local use.
- **README.** A "Continuous integration" section describing what runs when, plus a status
  badge. The README already documents `npm test`, `npm run typecheck` and `npm run e2e`;
  this closes the loop by saying where they run automatically.

## Rejected: a separate build job

The obvious optimisation is to build the Expo web export in its own job, publish `dist/`
as an artifact, and have `e2e` download and serve it — parallelising the build against
`npm ci` and saving perhaps a minute.

Rejected. The E2E design deliberately chains build and serve in a single `webServer`
entry so the bundle and the server hosting it can never disagree, and sets
`EXPO_PUBLIC_API_URL` at export time because that is the only thing that controls the
app's API target. Splitting those apart moves that invariant into workflow YAML, where it
is invisible to anyone reading the Playwright config, and creates a CI-only code path that
no developer exercises locally. A minute is not worth a divergence between how the test
runs on a laptop and how it runs on `master`.

Revisit if the export becomes the dominant cost and a measurement — not a guess — says so.

## Branch protection

Protection on `master` requires three check contexts, named for the jobs:

- `typecheck`
- `test`
- `e2e`

Configured in GitHub's settings, not in this repo. The repository's default branch is
already `master` (`gh api repos/victor-prp/lang-tutor --jq .default_branch` confirms it).
Only this local clone's cached `refs/remotes/origin/HEAD` is stale, still pointing at
`main`, a branch holding only the initial commit; that pointer is local-only and affects
nothing on GitHub. Clear it with `git remote set-head origin -a`.

## Verification

CI cannot be test-driven in the usual sense: the workflow's only real test is running on
GitHub. The plan verifies it empirically, in order:

1. Push the branch. Confirm three checks appear and all three go green.
2. Confirm the `e2e` job's artifact step did not run (nothing to upload on success).
3. Push a throwaway commit introducing a deliberate type error. Confirm `typecheck` goes
   red, and that `test` and `e2e` are unaffected — proving the jobs are genuinely
   independent rather than incidentally passing together.
4. Push a throwaway commit breaking an E2E assertion. Confirm `e2e` goes red and uploads a
   trace artifact that opens in `npx playwright show-trace`.
5. Revert both throwaway commits. Confirm the re-run is green and that the Playwright
   browser cache reports a hit, not a fresh download.

Steps 3 and 4 are the ones that matter. A workflow that passes has proven nothing about
whether it would ever fail.
