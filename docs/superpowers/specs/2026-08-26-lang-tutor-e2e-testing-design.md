# lang-tutor E2E Testing Design

**Goal:** Add a browser-driven end-to-end test that runs the real server and the real
mobile app together, clicks through a complete ten-question session, and asserts the
final score the learner sees is correct. One test, covering the happy path only.

**Relationship to earlier phases:** Phase 1 built the Expo app on mock data; phase 2
([design](2026-08-26-lang-tutor-phase-2-design.md) ·
[plan](../plans/2026-08-26-lang-tutor-phase-2.md)) moved session authority to
`apps/server` and added a real-HTTP integration test. That integration test drives the
server's API directly with `fetch` — it never renders the app. This design closes that
gap: nothing today verifies that tapping an option in the actual UI produces the right
score on the actual Results screen.

## Why a browser test, and why only the happy path

The existing test tiers each stop short of the client-server seam:

| Tier | Covers | Blind to |
|---|---|---|
| Unit (`packages/core`, `apps/server/src`, `apps/mobile/src`) | Pure logic in isolation | Anything crossing a process boundary |
| Route tests (`app.request()`) | Server routing in-process | Real sockets, real client |
| Integration (`tests/integration`) | Real HTTP against the real server | The app; rendering; user interaction |

The untested claim is the one the learner actually experiences: *tap ten options, get a
correct score*. That requires a rendered app and a running server at the same time.

Scope is deliberately one happy-path test. The value is in proving the loop closes at
all; a broad suite of browser tests is slow, brittle, and would duplicate assertions the
cheaper tiers already make better. Navigation edges and the error path are explicitly out
of scope (see Out of scope).

## Tooling: Playwright against the Expo web target

Playwright drives `expo start --web` in a real Chromium browser. Chosen over the
alternatives:

- **vs. Maestro/Detox (native):** those drive a real simulator or device, which is closer
  to production but needs a native build pipeline and far heavier setup. Playwright reuses
  the web target the team already develops against (`npm run mobile`, press `w`).
- **vs. a static export (`expo export -p web`) served as files:** the static route is more
  deterministic per run — no bundler in the loop mid-test — but adds a build step and a
  static-server dependency. The dev server tests exactly what developers run, with no new
  configuration. (`app.json` already sets `web.output: "static"`, so expo-router output
  mode is *not* an obstacle to the static route; the build step and
  tests-what-devs-run arguments carry this decision on their own.)

**The tradeoff this accepts:** web-rendered RTL is not identical to native RTL — phase 1
called this out explicitly and its plan required confirming layout on a real device. This
suite therefore verifies **behaviour and data flow, not native layout fidelity**. It is
not a substitute for the manual device pass. If native-only regressions become a real
problem later, Maestro is the follow-up, not a rewrite of this.

## Where it lives

A new `e2e/` workspace at the repo root, added to the root `workspaces` array as `"e2e"`:

```
e2e/
├── package.json          @playwright/test; scripts: "e2e" (NOT "test") + "typecheck"
├── playwright.config.ts  boots both servers, one Chromium project
├── tsconfig.json
└── tests/
    └── session.spec.ts   the happy-path test
```

Not under `apps/*` (it is not an app) and not `packages/*` (nothing imports it).

**The script is named `e2e`, not `test` — this is load-bearing.** The root's
`npm test --workspaces --if-present` would otherwise pick it up and drag a browser
download and two live servers into the fast unit-test loop that currently runs in
about a second. A new root script `npm run e2e` drives it instead, so `npm test` keeps
its existing meaning and speed.

**But it does need a `typecheck` script.** The root `npm run typecheck --workspaces
--if-present` skips any workspace without one — so omitting it would leave
`playwright.config.ts` and `session.spec.ts` as the only TypeScript in the repo that
nothing type-checks. Since the spec file imports shared types, that is exactly where a
silent drift would hide. `"typecheck": "tsc --noEmit"`, matching every other workspace.

## Process orchestration

Playwright's `webServer` accepts an array, so the config can start and stop both
processes itself.

- **Server:** `npm run start -w apps/server`, polled at `http://localhost:3001/health`.
  On a fresh boot this is `start` (plain `tsx`), deliberately **not** the root
  `npm run server` script, which maps to `dev` (`tsx watch`) — a file watcher restarting
  the server mid-test is nondeterminism a harness should not invite.
- **App:** `npm run web -w apps/mobile -- --port 8081`, with `EXPO_PUBLIC_API_URL` passed
  explicitly in that entry's `env` (see below). Note the bare `--`: without it npm swallows
  `--port` instead of forwarding it to `expo start`.
- **`reuseExistingServer: !process.env.CI`**, so a developer who already has both running
  gets attached to rather than hitting a port conflict.

**What `reuseExistingServer` costs, stated plainly.** When it attaches to an
already-running process, two things in this document stop holding: the server may well be
the `tsx watch` variant the bullet above avoids, and the session store is whatever state
that long-lived process accumulated rather than a fresh `Map`. Both are acceptable for a
local convenience run, and neither applies in CI where the flag is off. Every determinism
claim in this design — here and under State isolation — is therefore scoped to **a fresh
boot**, which is the mode that matters for a trustworthy result.

### `EXPO_PUBLIC_API_URL` must be forced, not inherited

This is the difference between the suite running and not running.
`apps/mobile/src/api/client.ts:19-21` throws `'EXPO_PUBLIC_API_URL is not set'` when the
variable is absent, and the variable's only source is `apps/mobile/.env.local` — a file
`.gitignore` excludes. Two failure modes follow:

- **Clean checkout:** no `.env.local`, so the app throws on the first tap and the test
  fails with no obvious cause.
- **This machine today:** `.env.local` holds `http://192.168.1.107:3001`, a LAN IP left
  over from phase 2's physical-device workflow. Metro inlines it into the bundle, so the
  browser calls that address instead of `localhost`. It passes only while the router keeps
  handing out that lease — it breaks on a new lease, another network, offline, or CI.

So the Metro `webServer` entry sets `env: { EXPO_PUBLIC_API_URL: 'http://localhost:3001' }`
explicitly. This leaves `.env.local` untouched, so the Expo Go device workflow keeps
working exactly as phase 2 documented it.

### Timeouts: the cold bundle does not land on `webServer.timeout`

`expo start --web` binds port 8081 within seconds, so `webServer.timeout` is satisfied
almost immediately — it only ever measures *the port answering*. Metro compiles the bundle
lazily, on the browser's first request, so the real 30-60s cold-bundle wait lands on
`page.goto()` and the first assertion after it.

The knobs that actually need raising are therefore `use.navigationTimeout`,
`use.actionTimeout`, and the per-test `timeout` (default 30s — on its own, less than a cold
bundle takes). Putting a generous number on `webServer.timeout` alone would leave the suite
failing on a cold cache with a misleading "element not found" instead of an honest wait.

### Metro's port must be pinned

Metro moves to another port if 8081 is already taken, which silently breaks a config
polling a fixed URL. Passing `--port 8081` makes a conflict fail loudly and immediately
instead of drifting somewhere the test will never look.

### A health endpoint is required

`apps/server` currently exposes only `POST` routes, so Playwright has nothing cheap to
poll to learn the server is ready — and it must not poll `POST /api/sessions`, which would
create junk sessions and emit spurious completion logs on every run.

This design therefore adds **`GET /health` → `{ ok: true }`** to `apps/server`. It is a
production addition rather than a test-only hook: any real deployment (load balancer,
container orchestrator, uptime check) wants exactly this endpoint. It reads no session
state and takes no parameters.

## Failures must be made loud

React Native Web's `Alert` is `class Alert { static alert() {} }` — a **literal no-op**
(verified in `node_modules/react-native-web/dist/exports/Alert/index.js`). Since
`useSession`'s `handleApiFailure` is built entirely on `Alert.alert`, every error path in
the app renders *nothing at all* in a browser.

For this suite that means a wrong API URL, a dead server, or a `Crypto.randomUUID` failure
all present identically: no dialog, no visible change, and a test that times out on
`progress-label` with no clue why. Debugging that from Playwright's output alone is
miserable.

The suite therefore installs its own diagnostics, which is the only reason a failure will
be legible:

- **`page.on('pageerror')`** — fail the test immediately, surfacing the thrown error
  (this is what turns the `EXPO_PUBLIC_API_URL` throw into a one-line diagnosis).
- **`page.on('console')`** — capture `error`-level messages and attach them to the failure.

Failing fast on a page error is preferred over letting the locator time out: a 5-second
explicit error beats a 30-second silent one.

### The product consequence, which is not a test problem

The same no-op means that **on web, a mid-session API failure strands the learner**: no
alert appears, and because the redirect lives in the dialog's `onPress`, `router.replace('/')`
never fires. They sit on a dead session screen with no route out.

This is a real defect in the app, not an artifact of testing — it is simply what made it
visible. It is **out of scope here** (this design adds a test suite; it does not change
product behaviour) and is recorded in Out of scope as follow-up work, because fixing it
means replacing `Alert` with a rendered component — a UI decision deserving its own
brainstorm, not a drive-by change smuggled in under a testing task.

## The test: a self-verifying score

The test clicks **option 0 on every question**, reads the feedback banner to learn whether
that choice happened to be right, tallies as it goes, and finally asserts the Results
screen displays exactly that tally.

```
click start-button
tally = 0, prompts = []
for n in 1..10:
    wait for progress-label to read "n / 10"   # the next question has rendered
    prompts.push(text of question-prompt)
    click option-0
    wait for either feedback-correct or feedback-wrong
    if feedback-correct is the one showing: tally++
    click continue-button

assert results-score reads "<tally> / 10"
assert count of missed-row === 10 - tally
assert prompts has 10 distinct values
```

Three assertions, each cross-checking a *separately computed* server field against
something the test derived independently:

- **`results-score` vs. `tally`** — the server's `score.correct` against ten independent
  per-question UI observations.
- **`missed-row` count vs. `10 - tally`** — `missed_questions` is computed by a different
  core function (`missed`, not `score`) over the same answers, so this catches a bug in one
  that the other would hide. Because options are shuffled server-side, clicking option 0
  is right only about a quarter of the time, so this list is non-empty on essentially every
  run — it is exercised, not just present. It also covers `results.tsx:37-51`, which no
  test touches today.
- **ten distinct prompts** — the position counter cannot detect a *re-served* question
  (a `next-step` idempotency bug replaying the same question would still advance the
  counter). Comparing prompts catches it. This is what `question-prompt` is for.

Waiting on `progress-label` reading `n / 10` — rather than on an option simply being
visible — is what keeps the loop honest. The previous question's options stay mounted
while the feedback banner is up, so "an option is visible" is true continuously and would
let the loop race ahead and click the same question twice. The position counter is the one
element guaranteed to change exactly once per advance.

**Why this shape rather than a seeded server.** The obvious alternative is to make question
selection deterministic (a `SEED` env var on the server) so the test can hardcode which
option is correct.

That alternative is genuinely cheap, and this design does not pretend otherwise.
`pickQuestions` already takes `rng` as a **required** parameter — phase 1 deliberately gave
it no default, commenting "a server must not inherit `Math.random` by accident" — so the
only `Math.random` in the stack is the default argument at `apps/server/src/session.ts:17`.
A seed would be a few lines there. The one wrinkle: `seededRng` ships in core but at
`utils/rng.ts`, and `utils` is deliberately absent from core's `exports` map, so it is
unreachable from `apps/server` today (phase 1 verified that boundary is
compiler-enforced). Seeding would mean widening core's public surface or duplicating the
generator — small, but a real architectural decision rather than a free change.

The tally approach is still preferred, on these grounds:

- It needs **no test-only production code.** No environment variable exists whose only
  purpose is to make the app testable, and core's encapsulation boundary stays where phase
  1 put it. (`GET /health` is not such a hook: it is meaningful to any real deployment.)
- It is **immune to the question pool changing.** Adding, removing, or reordering entries
  in `mockQuestions.ts` cannot break it, because it never asserts anything about *which*
  questions appear — a seeded test would need its expectations rewritten whenever the pool
  changed.
- It is still a **genuinely strong assertion.** The tally is derived from ten independent
  per-question UI observations; the score and missed list come from the server's own
  accounting over entirely separate paths. A scoring bug on either side — an off-by-one, a
  mis-attributed answer, a dropped `next-step` — makes them disagree and fails the test.

The one thing it deliberately does not pin down is the score's *value* (any run may score
anywhere from 0 to 10 depending on where `correct_option` lands). That is the right
trade: the invariant worth protecting is "the score shown matches the answers given," not
"the score is 10."

### The Unicode isolate hazard

`strings.progressLabel` and `strings.scoreLabel` wrap their text in U+2066 LEFT-TO-RIGHT
ISOLATE and U+2069 POP DIRECTIONAL ISOLATE, so the score element's text content is
literally `⁦7 / 10⁩`, not `7 / 10`. This was verified, not assumed — see Verified
facts. A naive `toHaveText('7 / 10')` fails against it.

The test strips those two code points in a small named helper before comparing, so the
assertion reads in terms of what a human sees. Stripping is preferred over a loose regex
because it keeps the failure message legible and documents *why* the characters are there.

## testIDs to add

React Native Web renders `testID` as `data-testid`, so Playwright's `getByTestId` works
directly. Six files gain `testID` props; **no component logic changes.**

| File | testIDs |
|---|---|
| `apps/mobile/src/app/index.tsx` | `start-button` |
| `apps/mobile/src/components/MultipleChoiceView.tsx` | `question-prompt`, `option-0` … `option-3` (index-suffixed) |
| `apps/mobile/src/components/OptionButton.tsx` | accepts a `testID` prop and forwards it to its `Pressable` |
| `apps/mobile/src/components/FeedbackBanner.tsx` | `feedback-correct` or `feedback-wrong` on the banner (chosen by `isCorrect`), `continue-button` |
| `apps/mobile/src/app/session.tsx` | `progress-label` — the loop's advance anchor |
| `apps/mobile/src/app/results.tsx` | `results-score`, `missed-row` (on each row of the missed list) |

**Why testIDs rather than roles and Hebrew text.** Every user-visible string is a
deliberate draft — phase 1's plan states the Hebrew copy was "written without a
native-speaker review" and lives in one file precisely so it can be rewritten cheaply.
Selectors keyed to that copy would break on the rewrite, which is a scheduled event, not a
hypothetical. `testID`s are stable across it.

The banner's testID varying by `isCorrect` is what makes the tally possible. This is an
idiomatic state-reflecting test id, not test logic leaking into the component: the banner
already branches on `isCorrect` for its colour, title, and whether it renders the answer.

## Verified facts

Probed against this repo's actual installed dependencies before writing this design,
rather than assumed:

| Fact | Result |
|---|---|
| `react-native-web` version in this repo | `0.21.2` |
| `testID` → `data-testid` | **Yes.** `<View testID="screen-root">` rendered `<div data-testid="screen-root">`. |
| `Pressable` + `accessibilityRole="button"` | Renders a real `<button role="button" tabindex="0" type="button">`, so it is clickable and focusable by Playwright. |
| Isolate characters survive to the DOM | **Yes.** `⁦7 / 10⁩` rendered with U+2066/U+2069 intact in the text node — confirming the hazard above is real. |
| `@playwright/test` current version | `1.62.1` |
| `Alert` under react-native-web | `class Alert { static alert() {} }` — a literal no-op. |
| `client.ts` behaviour without the env var | Throws `'EXPO_PUBLIC_API_URL is not set'` (`client.ts:19-21`). |
| `apps/mobile/.env.local` present and its value | Yes — `http://192.168.1.107:3001` (a LAN IP). |
| `pickQuestions`' `rng` parameter | **Required**, no default; the only `Math.random` is the default arg at `apps/server/src/session.ts:17`. |
| `seededRng` reachable from `apps/server`? | **No.** Lives in `utils/`, absent from core's `exports` map, not re-exported from any barrel. |
| `app.json` web output mode | `web.output: "static"` already set. |
| Port collision with the integration test | None — it binds `port: 0` (ephemeral). |

Still to verify during planning (each needs a live Metro boot, so deferred):

- That an inherited process `env` actually takes precedence over `.env.local` under Expo's
  dotenv loader. **The whole `EXPO_PUBLIC_API_URL` fix depends on this**; if precedence
  runs the other way, the fallback is a Playwright global-setup step that writes a
  temporary env file, or committing a `.env` with the localhost default so `.env.local`
  is the deliberate override.
- Whether Metro's bundle cache keys on `EXPO_PUBLIC_*` values, or whether a stale bundle
  built from the LAN IP can be served after the variable changes (a known class of Expo
  cache bug). If it does not invalidate, the plan needs `--clear` on the first run.
- That `page.goto()` plus generous action timeouts genuinely absorbs a cold bundle.

## What this covers that unit tests cannot

Beyond the score itself, the loop exercises real client-server *timing* — which is the
part no unit test in this repo can reach:

- **`useSession`'s `advanceRequested` path (`useSession.tsx:201-208`).** The test clicks
  Continue as soon as the feedback banner appears, which may well be before the background
  `nextStep` call has resolved. That is precisely the race `advanceRequested` exists to
  handle, and it is unreachable from a unit test because the repo has no hook tests at all
  (phase 1: "phase 1 tests pure logic, not React"). Whether it fires on a given run depends
  on real network timing, so the coverage is opportunistic rather than guaranteed — but a
  regression that broke it would surface here as a hung or double-advanced session.
- **The full `next-step` round trip under a real browser's fetch**, including CORS, which
  the in-process route tests bypass entirely.

## State isolation between runs

Two pieces of state could leak between runs. On a **fresh boot** (see
`reuseExistingServer` above) neither does:

- **`user_id`** is persisted via `AsyncStorage`, which is `localStorage` on web. Playwright
  gives each test a fresh browser context, so storage starts empty and a new `user_id` is
  generated per run. Nothing needs clearing. This holds regardless of how the servers were
  started.
- **Server sessions** live in an in-memory `Map` that dies with the process. When Playwright
  boots the server itself, sessions never carry over. When it *attaches* to an
  already-running server, they can — a stale completed session from an earlier run may
  still be in the store. Harmless for this suite, which only ever reads the session it
  creates, but it is the reason the determinism claims here are scoped to a fresh boot.

## Out of scope

- **Navigation edges** — "practise again" from Results, backing out mid-session. The
  happy path is the whole scope.
- **The error path.** Killing the server mid-session to assert the failure alert appears is
  excluded because **there is nothing to assert**: React Native Web's `Alert` is a verified
  no-op, so no dialog is ever rendered on web. This is a statement of fact, not an
  unverified risk.
- **Fixing that error path (follow-up work, recommended).** The no-op means a mid-session
  failure strands the web learner with no message and no way home, since `router.replace('/')`
  lives in the dialog's never-invoked `onPress`. Making it work means replacing `Alert` with
  a rendered component — a real UI decision, and one that would then also *become*
  E2E-testable. It belongs in its own brainstorm, not bolted onto a testing task.
- **Native layout / RTL fidelity.** Explicitly not covered; the manual device pass remains
  the authority.
- **CI integration.** The repo has no CI configuration at all today. The config is written
  so CI is a later addition (`reuseExistingServer` already keys off `process.env.CI`), but
  no workflow file is added.
- **Visual regression / screenshot assertions.** The UI is still being iterated on;
  snapshots would calcify it, the same reasoning phase 1 used to skip component tests.

## Cost to be aware of

`npx playwright install chromium` downloads a browser (~150MB) once per machine. This is a
one-time setup step, documented in the README, not something every run pays.
