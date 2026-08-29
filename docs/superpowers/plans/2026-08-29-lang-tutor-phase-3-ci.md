# Phase 3 CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every push to every branch runs typecheck, unit tests and the Playwright E2E
suite on GitHub Actions, as three independently-reportable jobs.

**Architecture:** A single workflow file, `.github/workflows/ci.yml`, defines three jobs
with no `needs:` between them so all three start at once. Each job repeats the same
preamble — checkout, `setup-node` reading a new `.nvmrc`, `npm ci` at the repo root — then
runs one root-level npm script. No application or test code changes: the E2E suite already
branches on `process.env.CI`, which GitHub Actions sets.

**Tech Stack:** GitHub Actions, Node 22, npm workspaces, Jest, TypeScript, Playwright
1.62.1.

**Spec:** [docs/superpowers/specs/2026-08-29-lang-tutor-phase-3-ci-design.md](../specs/2026-08-29-lang-tutor-phase-3-ci-design.md)

## Global Constraints

- **Node version: `22`**, pinned in `.nvmrc` at the repo root and consumed by
  `actions/setup-node` via `node-version-file`. Never hardcode a version literal in the
  workflow.
- **Job IDs are the branch-protection check contexts.** They must be exactly `typecheck`,
  `test` and `e2e`. Do not add a `name:` key to any job — that would change the reported
  context and silently break the protection rule on `master`.
- **`npm ci` runs at the repo root**, never inside a workspace. The root `package.json`
  owns dependency resolution for all four workspaces.
- **Jobs run only root-level npm scripts** (`npm run typecheck`, `npm test`,
  `npm run e2e`) — the same commands the README gives developers. No CI-only invocation
  of a workspace script directly.
- **`e2e/playwright.config.ts` must not be modified.** It already handles CI correctly
  via `process.env.CI`.
- **Nothing is added to `package.json` or `package-lock.json`.** This phase installs no
  new dependencies.
- **The trunk branch is `master`**, not `main`. `origin/HEAD` points at a stale `main`;
  ignore it.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `.nvmrc` | Create | Single source of truth for the Node version, for both `nvm use` locally and `setup-node` in CI. One line: `22`. |
| `.github/workflows/ci.yml` | Create | The whole pipeline: trigger, concurrency, and the three jobs. Nothing else lives here. |
| `README.md` | Modify | A "Continuous integration" section under the existing "Checks" section, plus a status badge near the top. |

Three files, no code changes. The E2E suite, the Jest configs and the workspace scripts are
all consumed as-is.

---

### Task 1: Node pin and the `typecheck` + `test` jobs

Delivers a working pipeline for the two cheap jobs and proves it can fail. The `e2e` job
is added separately in Task 2 so that a red `e2e` in Task 2 cannot be confused with a
broken preamble.

**Files:**
- Create: `.nvmrc`
- Create: `.github/workflows/ci.yml`
- Test: none — this is CI configuration. Verification is empirical, on GitHub, in Steps 5-10.

**Interfaces:**
- Consumes: the existing root scripts `npm run typecheck` and `npm test` from
  `package.json`, both of which fan out with `--workspaces --if-present`.
- Produces: `.github/workflows/ci.yml` with a top-level `jobs:` map that Task 2 appends an
  `e2e` key to, and the check contexts `typecheck` and `test`. Also `.nvmrc`, which Task 2's
  job reads through the same `node-version-file: .nvmrc` line.

- [ ] **Step 1: Pin the Node version**

```bash
echo "22" > .nvmrc
```

Bare major version, no `v` prefix. `setup-node` resolves `22` to the latest 22.x on the
runner; `nvm use` accepts the same string locally.

- [ ] **Step 2: Write the workflow with two jobs**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

# Every branch, every push. Deliberately no `pull_request` trigger: for branches in
# this repo `push` already fires on every commit a PR would contain, so adding it
# would run the whole suite twice per PR. Push-event check runs satisfy branch
# protection on master exactly as pull-request-event runs do.
on: push

# A run against a commit that is no longer the branch tip is not worth finishing.
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # Job IDs are the branch-protection check contexts. Do not add `name:` keys.
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      # Root install: the root package.json owns resolution for all four workspaces.
      - run: npm ci
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm test
```

The duplicated preamble is intentional. GitHub Actions has no step-level reuse within a
workflow short of a composite action or a reusable workflow, and six duplicated lines are
cheaper to read than either.

- [ ] **Step 3: Validate the YAML parses before pushing**

Run:

```bash
python3 -c "import yaml; d = yaml.safe_load(open('.github/workflows/ci.yml')); print(sorted(d['jobs']))"
```

Expected: `['test', 'typecheck']`

This catches indentation mistakes locally instead of after a push. Note that PyYAML parses
the bare `on:` key as the boolean `True` — that is a YAML 1.1 quirk in the parser, not a
problem in the file. GitHub's own parser reads it correctly. Do not "fix" it by quoting.

- [ ] **Step 4: Commit and push**

```bash
git add .nvmrc .github/workflows/ci.yml
git commit -m "Add CI workflow running typecheck and unit tests on every push"
git push -u origin phase-3-ci
```

- [ ] **Step 5: Watch the run and confirm both jobs pass**

```bash
gh run watch --exit-status
```

Expected: both `typecheck` and `test` conclude successfully. If `gh` picks the wrong run,
list them with `gh run list --branch phase-3-ci --limit 5` and watch by ID.

If a job fails here, read the log with `gh run view --log-failed` before changing anything.
The two most likely first-run failures are a missing action version (`Unable to resolve
action actions/checkout@v5` — drop to `@v4`) and a workspace test that depends on something
absent from a clean runner.

- [ ] **Step 6: Confirm the check contexts are named correctly**

```bash
gh api "repos/victor-prp/lang-tutor/commits/$(git rev-parse HEAD)/check-runs" \
  --jq '.check_runs[].name'
```

Expected, exactly: `typecheck` and `test`. Any other spelling means branch protection on
`master` will never match, and the rule would pass vacuously — the worst possible failure
mode, because it looks green.

- [ ] **Step 7: Prove `typecheck` can fail**

A pipeline that has only ever passed has demonstrated nothing. Introduce a deliberate type
error in `packages/core`, which every other workspace imports:

```bash
cat >> packages/core/src/domain/quiz.ts <<'EOF'

// TEMPORARY - reverted in the next commit. Proves CI's typecheck job fails.
export const ciCanaryShouldNotCompile: number = 'not a number';
EOF
git add packages/core/src/domain/quiz.ts
git commit -m "TEMP: deliberate type error to verify CI fails"
git push
```

- [ ] **Step 8: Confirm `typecheck` goes red and `test` stays green**

```bash
gh run watch   # no --exit-status: this run is expected to fail
```

Expected: `typecheck` fails with a TS2322 assignment error naming
`ciCanaryShouldNotCompile`; `test` passes. Both halves matter — a red `typecheck` proves
the job runs, and a green `test` alongside it proves the jobs are genuinely independent
rather than sharing a failure.

- [ ] **Step 9: Revert the canary**

```bash
git revert --no-edit HEAD
git push
```

Reverting rather than amending leaves the failed run in the history as evidence that the
gate works.

- [ ] **Step 10: Confirm green again**

```bash
gh run watch --exit-status
```

Expected: both jobs pass. Task 1 is complete when a passing run, a failing run, and a
passing run again all exist on this branch.

---

### Task 2: The `e2e` job

Adds the slow job: a cached Chromium, the Playwright run, and a trace artifact on failure.
Split from Task 1 because it is the only job with a cache, a browser install and an
artifact upload — three things a reviewer could reject independently of the two trivial
jobs.

**Files:**
- Modify: `.github/workflows/ci.yml` — append one `e2e` key to the existing `jobs:` map
- Test: none directly. Verification is empirical, in Steps 4-9.
- Do **not** modify: `e2e/playwright.config.ts`, `e2e/tests/session.spec.ts`

**Interfaces:**
- Consumes: `.nvmrc` and the `jobs:` map from Task 1; the existing root script
  `npm run e2e`, which delegates to `playwright test` in the `e2e` workspace.
- Produces: the check context `e2e`, and a `playwright-traces` artifact on failing runs.

- [ ] **Step 1: Append the `e2e` job**

Add to the end of `.github/workflows/ci.yml`, at the same indentation as `typecheck` and
`test`:

```yaml
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci

      # Browser binaries change when Playwright does, not when the lockfile does,
      # so the cache is keyed on the resolved version. Read from the e2e workspace
      # so it resolves whether or not npm hoists the package to the root.
      - name: Resolve Playwright version
        id: playwright
        working-directory: e2e
        run: |
          echo "version=$(node -p 'require("@playwright/test/package.json").version')" >> "$GITHUB_OUTPUT"

      - name: Cache Playwright browsers
        uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ steps.playwright.outputs.version }}

      # --with-deps installs Chromium's system libraries, which Ubuntu runners do
      # not ship. Without it the browser fails to launch with a shared-library
      # error that looks nothing like a test failure. It runs even on a cache hit:
      # the apt packages live outside the cached directory.
      - name: Install Chromium
        working-directory: e2e
        run: npx playwright install --with-deps chromium

      # Starts both servers itself — the Hono server and a freshly built static web
      # export. Nothing needs to be running first, and nothing is special-cased for
      # CI beyond what playwright.config.ts already does via process.env.CI.
      - run: npm run e2e

      # trace: 'retain-on-failure' is already set in the config, so a green run has
      # nothing to upload and if-no-files-found: ignore keeps that from erroring.
      - name: Upload Playwright traces
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-traces
          path: e2e/test-results/
          if-no-files-found: ignore
          retention-days: 7
```

- [ ] **Step 2: Validate the YAML parses and the job set is complete**

Run:

```bash
python3 -c "import yaml; d = yaml.safe_load(open('.github/workflows/ci.yml')); print(sorted(d['jobs'])); print([j for j in d['jobs'].values() if 'needs' in j])"
```

Expected: `['e2e', 'test', 'typecheck']` then `[]`. The empty second list is the check that
matters: any `needs:` would serialise the jobs and throw away the parallelism this design
exists for.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "Add e2e job running Playwright against a cached Chromium"
git push
```

- [ ] **Step 4: Watch the run and confirm all three jobs pass**

```bash
gh run watch --exit-status
```

Expected: `typecheck`, `test` and `e2e` all green. This first `e2e` run downloads Chromium
(~150MB) and builds the Expo web export with a cold Metro cache, so budget well beyond the
~9s warm export the README quotes — the config allows 300s for that step alone.

If it fails, `gh run view --log-failed` first. Two failures are worth recognising on sight:
a browser launch error mentioning a missing `.so` means `--with-deps` did not take effect,
and a `Timed out waiting ... from config.webServer` on the second entry means the export
itself failed — scroll up in the log for the Metro error rather than raising the timeout.

- [ ] **Step 5: Confirm all three check contexts exist**

```bash
gh api "repos/victor-prp/lang-tutor/commits/$(git rev-parse HEAD)/check-runs" \
  --jq '.check_runs[].name' | sort
```

Expected, exactly: `e2e`, `test`, `typecheck`. These three strings are what goes into the
branch-protection rule on `master`.

- [ ] **Step 6: Confirm nothing was uploaded on success**

```bash
gh run view --json jobs --jq '.jobs[] | select(.name == "e2e") | .steps[] | "\(.name): \(.conclusion)"'
```

Expected: every step `success` except `Upload Playwright traces`, which is `skipped`. A
green run must not be paying to store traces.

- [ ] **Step 7: Prove `e2e` catches a real app regression**

Break the app, not the test — that is the regression the job exists to catch, and it also
re-proves job independence, since renaming a test ID breaks neither typecheck nor the unit
tests:

```bash
sed -i '' 's/testID="start-button"/testID="start-button-ci-canary"/' apps/mobile/src/app/index.tsx
git add apps/mobile/src/app/index.tsx
git commit -m "TEMP: rename start-button testID to verify the e2e job fails"
git push
```

(On Linux, `sed -i` without the `''`.)

- [ ] **Step 8: Confirm `e2e` goes red, uploads a trace, and the other two stay green**

```bash
gh run watch   # no --exit-status: this run is expected to fail
```

Expected: `e2e` fails on the `home never rendered` assertion; `typecheck` and `test` pass.
Then download and open the trace:

```bash
gh run download --name playwright-traces --dir /tmp/ci-trace
npx playwright show-trace "$(find /tmp/ci-trace -name trace.zip | head -1)"
```

Expected: the trace opens and shows the run stalling on the home screen. This is the whole
point of the artifact step — an E2E failure on CI has to be debuggable without reproducing
it locally.

- [ ] **Step 9: Revert the canary and confirm the browser cache hits**

```bash
git revert --no-edit HEAD
git push
gh run watch --exit-status
```

Expected: all three green. In the `e2e` job's log, `Cache Playwright browsers` reports a
cache hit and `Install Chromium` completes in seconds rather than re-downloading. If it
misses, the cache key is unstable — check that `steps.playwright.outputs.version` resolved
to `1.62.1` and is not empty.

---

### Task 3: Document CI in the README

The pipeline is worthless to a newcomer who cannot tell what runs automatically and what
they are expected to run themselves. Last because the text must describe the workflow as
built, not as planned.

**Files:**
- Modify: `README.md` — a badge after the title (line 1), and a new section between
  `## Checks` (line 54) and `## End-to-end test` (line 61)
- Test: none. Verified by reading and by the badge rendering on GitHub.

**Interfaces:**
- Consumes: the workflow file and job names from Tasks 1 and 2. Nothing consumes this task.

- [ ] **Step 1: Add the status badge**

Insert directly below the `# lang-tutor` title on line 1, as its own paragraph:

```markdown
[![CI](https://github.com/victor-prp/lang-tutor/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/victor-prp/lang-tutor/actions/workflows/ci.yml)
```

`?branch=master` is required. Without it the badge tracks the repository's default branch,
which is currently the stale `main` — it holds only the initial commit and no workflow
file, so the badge would read "no status" forever while `master` is perfectly green.

- [ ] **Step 2: Add the Continuous integration section**

Insert between the end of the `## Checks` block and the `## End-to-end test` heading:

```markdown
## Continuous integration

Every push, on every branch, runs all three of the above on GitHub Actions
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

Pushing again cancels the previous run for that branch. Merging to `master` requires all
three checks to pass.

The Node version comes from `.nvmrc`, which is also what `nvm use` reads — keep local and
CI on the same major version by changing that one file.
```

- [ ] **Step 3: Check the links and table render**

Run:

```bash
sed -n '1,5p;54,80p' README.md
```

Expected: the badge sits directly under the title, and the new section sits between the
`## Checks` code block and `## End-to-end test` with a blank line either side of the
heading and the table.

- [ ] **Step 4: Commit and push**

```bash
git add README.md
git commit -m "Document the CI pipeline and add a status badge"
git push
```

- [ ] **Step 5: Confirm the badge renders green**

Open `https://github.com/victor-prp/lang-tutor/tree/phase-3-ci` and check the badge
shows a passing CI. A "no status" badge means the `?branch=` parameter is wrong or the
workflow filename in the URL does not match `ci.yml`.

Note the badge will be accurate only once this branch is merged to `master`, since it is
pinned to that branch — before the merge it reports `master`'s last state, which has no
workflow at all. Expect "no status" until merge; that is correct behaviour, not a bug to
chase.

- [ ] **Step 6: Confirm the final run is green**

```bash
gh run watch --exit-status
```

Expected: all three jobs pass. The branch is now ready to merge.

---

## After the plan

Two follow-ups this plan deliberately does not do, recorded so they are not lost:

1. **Repoint the repository default branch to `master`.** `origin/HEAD` points at `main`,
   which holds only the initial commit while `master` carries all the real work. Until it
   is fixed, new pull requests propose the wrong base. `gh repo edit --default-branch master`,
   or GitHub Settings → General → Default branch. Once done, the README badge's
   `?branch=master` becomes redundant but stays harmless.
2. **Add the three check contexts to the `master` protection rule** — `typecheck`, `test`,
   `e2e` — if they are not already required. A protection rule naming a context that no
   workflow produces passes vacuously, so verify against the names Task 2 Step 5 printed
   rather than from memory.
