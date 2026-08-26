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
  deterministic per run — no bundler in the loop — but adds a build step, a static-server
  dependency, and a dependency on the web output mode being configured correctly for
  expo-router. The dev server tests exactly what developers run, with no new
  configuration.

**The tradeoff this accepts:** web-rendered RTL is not identical to native RTL — phase 1
called this out explicitly and its plan required confirming layout on a real device. This
suite therefore verifies **behaviour and data flow, not native layout fidelity**. It is
not a substitute for the manual device pass. If native-only regressions become a real
problem later, Maestro is the follow-up, not a rewrite of this.

## Where it lives

A new `e2e/` workspace at the repo root, added to the root `workspaces` array as `"e2e"`:

```
e2e/
├── package.json          @playwright/test; script named "e2e", NOT "test"
├── playwright.config.ts  boots both servers, one Chromium project
├── tsconfig.json
└── tests/
    └── session.spec.ts   the happy-path test
```

Not under `apps/*` (it is not an app) and not `packages/*` (nothing imports it).

**The script is named `e2e`, not `test` — this is load-bearing.** The root's
`npm test --workspaces --if-present` would otherwise pick it up and drag a browser
download and two live servers into the fast unit-test loop that currently runs in
about a second. A new root script `npm run e2e` drives it instead, so
`npm test` and `npm run typecheck` keep their existing meaning and speed.

## Process orchestration

Playwright's `webServer` accepts an array, so the config owns starting and stopping both
processes; the test never assumes something is already running.

- **Server:** `npm run start -w apps/server`, polled at `http://localhost:3001/health`.
  Note `start` (plain `tsx`), deliberately **not** the root `npm run server` script, which
  maps to `dev` (`tsx watch`) — a file watcher restarting the server mid-test is exactly
  the kind of nondeterminism a test harness must not invite.
- **App:** `npm run web -w apps/mobile` on port 8081, with a **long startup timeout**
  (~3 minutes) because a cold Metro bundle is slow. This is the single most likely source
  of a first-run failure and is called out as such in the plan.
- **`reuseExistingServer: true` when not in CI**, so a developer who already has both
  running gets attached to rather than double-booted (port conflicts otherwise).

### A health endpoint is required

`apps/server` currently exposes only `POST` routes, so Playwright has nothing cheap to
poll to learn the server is ready — and it must not poll `POST /api/sessions`, which would
create junk sessions and emit spurious completion logs on every run.

This design therefore adds **`GET /health` → `{ ok: true }`** to `apps/server`. It is a
production addition rather than a test-only hook: any real deployment (load balancer,
container orchestrator, uptime check) wants exactly this endpoint. It reads no session
state and takes no parameters.

## The test: a self-verifying score

The test clicks **option 0 on every question**, reads the feedback banner to learn whether
that choice happened to be right, tallies as it goes, and finally asserts the Results
screen displays exactly that tally.

```
click start-button
tally = 0
for n in 1..10:
    wait for progress-label to read "n / 10"   # the next question has rendered
    click option-0
    wait for either feedback-correct or feedback-wrong
    if feedback-correct is the one showing: tally++
    click continue-button
assert results-score reads "<tally> / 10"
```

Waiting on `progress-label` reading `n / 10` — rather than on an option simply being
visible — is what keeps the loop honest. The previous question's options stay mounted
while the feedback banner is up, so "an option is visible" is true continuously and would
let the loop race ahead and click the same question twice. The position counter is the one
element guaranteed to change exactly once per advance.

**Why this shape rather than a seeded server.** The obvious alternative is to make question
selection deterministic (a `SEED` env var on the server) so the test can hardcode which
option is correct. This design rejects that:

- It needs **no test-only hook in production code.** `pickQuestions`' use of `Math.random`
  stays untouched, and no environment variable exists whose only purpose is to make the
  app testable. (The one server addition, `GET /health`, is not such a hook: it is
  meaningful to any real deployment and would be worth adding with or without this suite.)
- It is **immune to the question pool changing.** Adding, removing, or reordering entries
  in `mockQuestions.ts` cannot break it, because it never asserts anything about *which*
  questions appear.
- It is still a **genuinely strong assertion.** The tally is derived from ten independent
  per-question UI observations; the final score comes from the server's own accounting
  over an entirely separate path. A scoring bug on either side — an off-by-one, a
  mis-attributed answer, a dropped `next-step` — makes the two disagree and fails the test.

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
| `apps/mobile/src/app/results.tsx` | `results-score` |

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

Still to verify during planning (heavier, needs a live Metro boot): that Playwright's
`webServer` array successfully waits out a cold Expo bundle, and the exact port Metro
settles on.

## State isolation between runs

Two pieces of state could leak between runs; neither does:

- **`user_id`** is persisted via `AsyncStorage`, which is `localStorage` on web. Playwright
  gives each test a fresh browser context, so storage starts empty and a new `user_id` is
  generated per run. Nothing needs clearing.
- **Server sessions** live in an in-memory `Map` that dies with the process, and Playwright
  starts the server per run. Sessions never carry over.

## Out of scope

- **Navigation edges** — "practise again" from Results, backing out mid-session. The
  happy path is the whole scope.
- **The error path.** Killing the server mid-session to assert the failure alert appears is
  excluded because it depends on `Alert.alert` under React Native Web, whose browser
  behaviour is unverified and may not be observable by Playwright at all. Testing it could
  force a production change (swapping `Alert` for a rendered component) purely to make it
  testable — a change worth making on its own merits, if ever, not as a side effect of
  wanting a test.
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
