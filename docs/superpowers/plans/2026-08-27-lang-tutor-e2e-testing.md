# lang-tutor E2E Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Playwright test that runs the real Hono server and a real static build of the Expo app together, clicks through a complete ten-question session in Chromium, and asserts the score, the missed-question count, and that ten distinct questions were served.

**Architecture:** A new `e2e/` workspace. Playwright's `webServer` array starts two processes: `apps/server` via `tsx`, and a static web export served by `expo serve`. The export is built with `EXPO_PUBLIC_API_URL` forced to `http://localhost:3001`, which is the only reliable way to control the app's API target (the Metro dev server ignores it — see the spec). The test clicks option 0 on every question and learns from the feedback banner whether it was right, so it needs no seeded RNG and no test-only hook: the tally it derives independently must match the score the server computes.

**Tech Stack:** `@playwright/test` 1.62.1 (Chromium only), Expo CLI's `export` + `serve` (no new static-server dependency), TypeScript 6 matching every other workspace.

**Spec:** [docs/superpowers/specs/2026-08-26-lang-tutor-e2e-testing-design.md](../specs/2026-08-26-lang-tutor-e2e-testing-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **The suite must never depend on `apps/mobile/.env.local`.** It is `.gitignore`d and on this machine holds a LAN IP. `EXPO_PUBLIC_API_URL=http://localhost:3001` is passed to the *export* command, which inlines it at build time. Never modify, move, or delete `.env.local` — phase 2's Expo Go device workflow depends on it.
- **`testID` additions must not change component logic.** Props only. Every existing test must still pass unchanged.
- **No new user-visible strings.** This plan adds no copy; `strings.ts` is untouched.
- **The `e2e` workspace's test script is named `e2e`, not `test`.** The root `npm test --workspaces --if-present` must keep skipping it, so `npm test` stays fast. It *does* get a `typecheck` script so the root typecheck covers it.
- **Ports:** server `3001`, static app `8081`. Both pinned explicitly. The existing integration test binds `port: 0`, so it never collides.
- **Verification commands.** From the repo root, `npm test` and `npm run typecheck` must both be clean before any commit, and `npm run e2e` must pass before the final commit.

## Verified environment

Probed in this repo before writing this plan. The dev-server findings are why this plan uses a static export.

| Fact | Verified value |
|---|---|
| `@playwright/test` | `1.62.1` |
| `react-native-web` | `0.21.2` |
| `testID` → DOM | Renders `data-testid`; `Pressable` + `accessibilityRole="button"` renders a real `<button role="button" tabindex="0" type="button">`. |
| Unicode isolates reach the DOM | Yes — `⁦7 / 10⁩` keeps U+2066/U+2069 in the text node. Assertions must strip them. |
| **Forced env, dev server** | **Ignored.** `client.ts` is transformed to read `_expoVirtualEnv.env.EXPO_PUBLIC_API_URL`, a module generated from `.env.local`. `webServer.env` reaches only `process.env`, via a block Expo labels `/* HMR env vars from Expo CLI (dev-only) */`. `EXPO_NO_DOTENV=1` did not help. Both tested with `--clear`, so not cache staleness. |
| **Forced env, `expo export`** | **Respected.** Inlined as `fetch(\`http://localhost:3001${s}\`…)`; the `.env.local` LAN IP appears 0 times in the output. |
| `expo export -p web` duration | ~9s warm. Emits `index.html`, `session.html`, `results.html`, `_sitemap.html`, `+not-found.html`. |
| `expo serve` | Exists in SDK 57: `npx expo serve <dir> --port <n>`. No new dependency needed. |
| `Alert` under react-native-web | `class Alert { static alert() {} }` — a literal no-op, so **every** app error path renders nothing in a browser. This is why Task 3 installs `pageerror` diagnostics before writing the real test. |
| `pickQuestions` | Takes `rng` as a **required** parameter; the only `Math.random` is the default arg at `apps/server/src/session.ts:17`. |
| Integration-test port | `port: 0` (ephemeral) — no conflict with 3001/8081. |

**Still unverified, and deliberately the first task:** that Chromium actually loads the served export and renders a question end to end. No amount of static inspection settles it, so Task 3 is a walking skeleton that proves the pipeline before any real assertions are written.

## Task order and why

| Task | Deliverable | Gate |
|---|---|---|
| 1 | `GET /health` on `apps/server` | New route test passes |
| 2 | `testID` props on six client files | Existing tests + typecheck still clean |
| 3 | `e2e/` workspace + config + **walking-skeleton test** | Chromium reaches question 1 against the real server |
| 4 | The full happy-path loop with all three assertions | `npm run e2e` green |
| 5 | README + root script | Docs match reality |

Health endpoint first because Playwright's readiness poll depends on it. `testID`s second because they are pure additions that can be verified by the existing suite alone. The walking skeleton third — it is the riskiest step and the one that either validates or destroys the whole approach, so it happens before effort is sunk into assertions. The full loop last, built on a pipeline already known to work.

---

## Task 1: `GET /health` on `apps/server`

**Files:**
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/app.test.ts` (new)

**Interfaces:**
- Consumes: `createApp` from `./app` (already exists).
- Produces: `GET /health` → `200 { ok: true }`. No parameters, reads no session state.

Playwright needs something cheap to poll to know the server is up. It must not poll
`POST /api/sessions`, which would create a junk session and emit a spurious completion log
on every run. This is also the first test to cover `app.ts` itself — until now only the
router had tests.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/app.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { createApp } from './app';

describe('GET /health', () => {
  it('returns 200 with ok: true', async () => {
    const res = await createApp().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not create a session as a side effect', async () => {
    const app = createApp();
    await app.request('/health');
    // A session id is only ever handed out by POST /api/sessions. If /health
    // had created one, the store would answer for it; nothing else can know an
    // id, so the only observable proof is that the sessions route is untouched
    // and still rejects an unknown id.
    const res = await app.request('/api/sessions/any-id/next-step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'u1', question_id: 'q1', option_index: 0 }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm test --workspace apps/server
```

Expected: FAIL — the first test gets `404` instead of `200`, because no `/health` route exists.

- [ ] **Step 3: Add the route**

In `apps/server/src/app.ts`, add the route inside `createApp`, before the `app.route(...)` line:

```ts
export function createApp() {
  const app = new Hono();
  app.use('*', cors());
  // Liveness probe. Deliberately reads no session state and takes no
  // parameters, so a readiness poll cannot perturb the store. When storage
  // lands this is where a DB-connectivity check belongs.
  app.get('/health', (c) => c.json({ ok: true }));
  const store = createSessionStore();
  app.route('/api/sessions', createSessionsRouter(store, mockQuestions));
  return app;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm test --workspace apps/server
npm run typecheck --workspace apps/server
```

Expected: PASS, 2 new tests; `tsc` silent.

- [ ] **Step 5: Confirm it answers over real HTTP**

```bash
npm run start -w apps/server &
sleep 2
curl -s -i http://localhost:3001/health | head -1
curl -s http://localhost:3001/health
kill %1
```

Expected: `HTTP/1.1 200 OK` and body `{"ok":true}`. This is the exact request Playwright's
`webServer` will poll.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/app.test.ts
git commit -m "Add GET /health liveness endpoint to apps/server"
```

---

## Task 2: `testID` props on the client

**Files:**
- Modify: `apps/mobile/src/components/OptionButton.tsx`
- Modify: `apps/mobile/src/components/MultipleChoiceView.tsx`
- Modify: `apps/mobile/src/components/FeedbackBanner.tsx`
- Modify: `apps/mobile/src/app/index.tsx`
- Modify: `apps/mobile/src/app/session.tsx`
- Modify: `apps/mobile/src/app/results.tsx`

**Interfaces:**
- `OptionButton` gains an optional `testID?: string` prop, forwarded to its `Pressable`.
- No other component signature changes. Every other edit is a literal `testID="..."` on an
  existing element.
- Produces these DOM hooks (`testID` renders as `data-testid`, verified):
  `start-button`, `progress-label`, `question-prompt`, `option-0`…`option-3`,
  `feedback-correct` / `feedback-wrong`, `continue-button`, `results-score`, `missed-row`.

**There is no new test in this task.** These are prop-only additions with no logic; the gate
is that the entire existing suite and `tsc` stay clean, proving nothing was disturbed. The
props are exercised for real in Tasks 3 and 4.

Selectors use `testID` rather than Hebrew text because that copy is an explicit draft that
phase 1 expects to be rewritten; `testID`s survive the rewrite.

- [ ] **Step 1: Give `OptionButton` a forwardable `testID`**

In `apps/mobile/src/components/OptionButton.tsx`, add `testID` to the `Props` type:

```ts
type Props = {
  label: string;
  state: OptionVisualState;
  disabled: boolean;
  minHeight?: number;
  testID?: string;
  onPress: () => void;
  onMeasure: (height: number) => void;
};
```

Destructure it and pass it to the `Pressable`:

```tsx
export function OptionButton({
  label,
  state,
  disabled,
  minHeight,
  testID,
  onPress,
  onMeasure,
}: Props) {
  function handleLayout(event: LayoutChangeEvent) {
    onMeasure(event.nativeEvent.layout.height);
  }

  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      onLayout={handleLayout}
```

Leave the `style` prop, the `<Text>` child, and both `StyleSheet.create` blocks exactly as
they are.

- [ ] **Step 2: Tag the prompt and the options**

In `apps/mobile/src/components/MultipleChoiceView.tsx`, add `testID` to the prompt `Text`:

```tsx
      <Text style={styles.prompt} testID="question-prompt">{question.question}</Text>
```

and give each `OptionButton` an index-suffixed id — the test always clicks `option-0`:

```tsx
          <OptionButton
            key={`${question.id}-${index}`}
            testID={`option-${index}`}
            label={option}
```

Leave the `instruction` `Text`, the height-matching logic, and `visualState` untouched.

- [ ] **Step 3: Tag the feedback banner and its Continue button**

In `apps/mobile/src/components/FeedbackBanner.tsx`, put a state-dependent `testID` on the
`Animated.View`. This is what lets the test learn whether its click was right, and it
mirrors a branch the component already makes for colour and title:

```tsx
    <Animated.View
      testID={isCorrect ? 'feedback-correct' : 'feedback-wrong'}
      style={[
```

and tag the Continue `Pressable`:

```tsx
      <Pressable
        accessibilityRole="button"
        testID="continue-button"
        onPress={onContinue}
        style={styles.button}
      >
```

- [ ] **Step 4: Tag the Home start button**

In `apps/mobile/src/app/index.tsx`:

```tsx
      <Pressable
        accessibilityRole="button"
        testID="start-button"
        onPress={onStart}
        style={styles.button}
      >
```

- [ ] **Step 5: Tag the progress counter**

In `apps/mobile/src/app/session.tsx`, on the counter `Text` — this is the element the test
waits on to know a new question has rendered:

```tsx
        <Text style={styles.counter} testID="progress-label">
          {strings.progressLabel(session.position, session.total)}
        </Text>
```

- [ ] **Step 6: Tag the score and each missed row**

In `apps/mobile/src/app/results.tsx`, tag the score `Text`:

```tsx
        <Text style={styles.score} testID="results-score">
          {strings.scoreLabel(correctCount, total)}
        </Text>
```

and each row of the missed list — note the same `testID` on every row, so Playwright can
count them:

```tsx
            {missedQuestions.map(({ question, correct_answer }) => (
              <View key={question.id} style={styles.missedRow} testID="missed-row">
```

- [ ] **Step 7: Verify nothing broke**

```bash
npm test
npm run typecheck
```

Expected: every existing test still passing, unchanged in count; `tsc` silent across all
workspaces. If any test changed behaviour, a `testID` was placed on the wrong element or a
prop was renamed — revert and redo the offending step.

- [ ] **Step 8: Prove the ids actually reach the DOM**

The whole selector strategy depends on this, so confirm it against a real build rather than
trusting it:

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=http://localhost:3001 npx expo export -p web --output-dir /tmp/e2e-testid-check
grep -o 'data-testid="[^"]*"' -r /tmp/e2e-testid-check/_expo | sort -u
grep -c 'start-button' /tmp/e2e-testid-check/index.html
rm -rf /tmp/e2e-testid-check
cd ../..
```

Expected: the grep over the bundle lists the ids added above (they appear as string
literals), and `index.html` — which is statically pre-rendered — contains `start-button` at
least once. Seeing `start-button` in the pre-rendered HTML is the strongest available
confirmation short of running a browser.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/src
git commit -m "Add testID props for E2E selectors"
```

---

## Task 3: The `e2e` workspace and a walking skeleton

**Files:**
- Create: `e2e/package.json`, `e2e/tsconfig.json`, `e2e/playwright.config.ts`, `e2e/urls.ts`
- Create: `e2e/tests/support/diagnostics.ts`
- Create: `e2e/tests/session.spec.ts`
- Modify: root `package.json` (add the `e2e` workspace and an `e2e` script)
- Modify: `apps/mobile/package.json` (add `build:web` and `serve:web` scripts)

**Interfaces:**
- Consumes: `GET /health` (Task 1), the `testID`s (Task 2).
- Produces:
  - `apps/mobile` scripts `build:web` (`expo export -p web --output-dir dist`) and
    `serve:web` (`expo serve dist --port 8081`)
  - `API_URL` and `APP_URL` from `e2e/urls.ts` — a standalone module so the spec never has
    to import `playwright.config.ts` (which uses `__dirname` and is better left out of the
    specs' module graph)
  - `attachDiagnostics(page, apiUrl): Diagnostics` and `diagnosticReport(d): string` from
    `e2e/tests/support/diagnostics.ts`
  - `e2e/tests/session.spec.ts` — one test, replaced wholesale in Task 4

**This task is the risk gate.** Everything static has been verified; what has not is that
Chromium loads the served export and reaches a question against the live server. Prove that
before writing assertions, so a fundamental problem surfaces now rather than after the loop
is built.

### Why the diagnostics come first

`Alert` is a verified no-op, and `useSession` wraps its API calls in
`try { … } catch { handleApiFailure() }`. So a failure is **caught, routed to a no-op, and
discarded** — it produces no dialog, no `pageerror`, and no visible change. A naive test
would just time out on `progress-label` with nothing to go on.

Note this makes `page.on('pageerror')` almost useless on its own here — the interesting
failures never reach it. What distinguishes them is **network traffic**:

| Symptom | Meaning |
|---|---|
| No request to the API at all | The inlined URL is wrong/absent, or the click never landed |
| Request made, failed | Server down, wrong port, or CORS |
| Request succeeded, UI unchanged | A real client bug — the interesting case |

The helper therefore records all three, and every assertion attaches the report.

- [ ] **Step 1: Add the app's build and serve scripts**

In `apps/mobile/package.json`, add to `"scripts"`:

```json
    "build:web": "expo export -p web --output-dir dist",
    "serve:web": "expo serve dist --port 8081",
```

`dist/` is already covered by both the root and `apps/mobile` `.gitignore`, so nothing new
needs ignoring.

- [ ] **Step 2: Confirm the build is repeatable into an existing directory**

Run it twice — a second export into a populated `dist/` must not prompt or fail:

```bash
npm run build:web -w apps/mobile
npm run build:web -w apps/mobile
ls apps/mobile/dist/index.html apps/mobile/dist/session.html apps/mobile/dist/results.html
```

Expected: both runs succeed and all three HTML files exist. If the second run errors or
prompts about a non-empty directory, change the script to
`rm -rf dist && expo export -p web --output-dir dist` and re-verify. (This repo is already
macOS-only in its tooling assumptions — phase 2's plan uses `ipconfig getifaddr en0` — so a
POSIX `rm -rf` is acceptable here.)

- [ ] **Step 3: Confirm `expo serve` actually serves it**

```bash
npm run serve:web -w apps/mobile &
sleep 3
curl -s -o /dev/null -w "GET / -> %{http_code}\n" http://localhost:8081/
curl -s http://localhost:8081/ | grep -c 'start-button'
kill %1
```

Expected: `200`, and at least one `start-button` hit in the statically pre-rendered HTML.
This is the URL Playwright will poll and the markup it will drive.

- [ ] **Step 4: Register the workspace and the root script**

In the root `package.json`, add `"e2e"` to `workspaces` and an `e2e` script:

```json
{
  "name": "lang-tutor",
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*",
    "e2e"
  ],
  "scripts": {
    "mobile": "npm run start --workspace apps/mobile",
    "server": "npm run dev --workspace apps/server",
    "e2e": "npm run e2e --workspace e2e",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

- [ ] **Step 5: Create the `e2e` package manifest**

The test script is `e2e`, **not** `test`, so `npm test --workspaces --if-present` keeps
skipping this workspace and the fast unit loop stays fast. `typecheck` *is* present, so the
root typecheck covers the config and specs.

Create `e2e/package.json`:

```json
{
  "name": "e2e",
  "version": "0.1.0",
  "private": true,
  "devDependencies": {
    "@playwright/test": "^1.62.1",
    "@types/node": "^22.0.0",
    "typescript": "~6.0.3"
  },
  "scripts": {
    "e2e": "playwright test",
    "typecheck": "tsc --noEmit"
  }
}
```

`@types/node` is required because `tsconfig.json` below sets `"types": ["node"]` — the
config imports `node:path` and reads `process.env`.

- [ ] **Step 6: Create the TypeScript config**

Playwright runs TypeScript directly, so this exists only for `tsc --noEmit`. Unlike the
other workspaces it needs DOM libs and Node types, because the specs touch both.

Create `e2e/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 7: Install and fetch the browser**

```bash
npm install
npx playwright install chromium
```

Expected: `e2e` appears as a workspace, and Chromium downloads (~150MB, one time per
machine). Confirm:

```bash
ls -d node_modules/@playwright/test && npx playwright --version
```

- [ ] **Step 8: Write the shared URL constants**

Both the Playwright config and the specs need these. They live in their own module so a spec
never has to import `playwright.config.ts` — that file uses `__dirname`, and keeping it out
of the specs' import graph avoids any CJS/ESM interop question.

Create `e2e/urls.ts`:

```ts
/** The Hono server started by playwright.config.ts's first webServer entry. */
export const API_URL = 'http://localhost:3001';

/** The static web export served by the second webServer entry. */
export const APP_URL = 'http://localhost:8081';
```

- [ ] **Step 9: Write the diagnostics helper**

Create `e2e/tests/support/diagnostics.ts`:

```ts
import type { Page } from '@playwright/test';

export type Diagnostics = {
  pageErrors: string[];
  consoleErrors: string[];
  apiRequests: string[];
  failedRequests: string[];
};

/**
 * The app swallows every API failure: useSession catches it and calls
 * Alert.alert, which react-native-web implements as a literal no-op. So a
 * broken URL or a dead server produces no dialog, no page error, and no
 * visible change — only a test that times out for no stated reason.
 *
 * Recording network traffic is what makes those cases distinguishable:
 * no API request at all means the inlined URL is wrong, a failed request
 * means the server is unreachable, and a successful request with an
 * unchanged UI is a genuine client bug.
 */
export function attachDiagnostics(page: Page, apiUrl: string): Diagnostics {
  const d: Diagnostics = {
    pageErrors: [],
    consoleErrors: [],
    apiRequests: [],
    failedRequests: [],
  };

  page.on('pageerror', (error) => d.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') d.consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (request.url().startsWith(apiUrl)) {
      d.apiRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    d.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`);
  });

  return d;
}

/** Rendered into assertion messages so a failure explains itself. */
export function diagnosticReport(d: Diagnostics): string {
  const lines = [
    `API requests seen (${d.apiRequests.length}):`,
    ...d.apiRequests.map((r) => `  ${r}`),
    `Failed requests (${d.failedRequests.length}):`,
    ...d.failedRequests.map((r) => `  ${r}`),
    `Page errors (${d.pageErrors.length}):`,
    ...d.pageErrors.map((r) => `  ${r}`),
    `Console errors (${d.consoleErrors.length}):`,
    ...d.consoleErrors.map((r) => `  ${r}`),
  ];
  if (d.apiRequests.length === 0) {
    lines.push(
      'NOTE: zero API requests. The bundle probably has the wrong EXPO_PUBLIC_API_URL',
      '      inlined — rebuild the export with it set explicitly.',
    );
  }
  return lines.join('\n');
}
```

- [ ] **Step 10: Write the Playwright config**

Create `e2e/playwright.config.ts`:

```ts
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { API_URL, APP_URL } from './urls';

const REPO_ROOT = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './tests',
  // One worker, no parallelism: the server keeps sessions in a shared in-memory
  // Map, so concurrent specs would interleave against the same store. There is
  // also only one spec.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    // Left near default deliberately: the app is a pre-built static bundle, so
    // nothing compiles mid-test and page loads are fast. Under the Metro dev
    // server these would have needed raising — see the spec for why that
    // approach was rejected.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run start -w apps/server',
      cwd: REPO_ROOT,
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Build and serve chained in one entry so the bundle and the server
      // hosting it can never disagree. EXPO_PUBLIC_API_URL must be set HERE:
      // export-time inlining is the only thing that controls the app's API
      // target, and it overrides apps/mobile/.env.local without touching it.
      command: 'npm run build:web -w apps/mobile && npm run serve:web -w apps/mobile',
      cwd: REPO_ROOT,
      url: APP_URL,
      env: { EXPO_PUBLIC_API_URL: API_URL },
      reuseExistingServer: !process.env.CI,
      // Generous: Playwright starts counting before the export begins. ~9s warm,
      // materially slower on a cold Metro cache.
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
```

- [ ] **Step 11: Write the walking-skeleton test**

Create `e2e/tests/session.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';

test('loads the app and serves a first question from the real server', async ({ page }) => {
  const diagnostics = attachDiagnostics(page, API_URL);

  await page.goto('/');
  await expect(page.getByTestId('start-button')).toBeVisible();

  await page.getByTestId('start-button').click();

  // The session screen renders nothing until the server's first question
  // arrives, so these three passing means the whole pipeline works:
  // export -> serve -> browser -> Hono -> browser -> render.
  await expect(
    page.getByTestId('progress-label'),
    `progress label never appeared\n${diagnosticReport(diagnostics)}`,
  ).toBeVisible();
  await expect(page.getByTestId('question-prompt')).toBeVisible();
  await expect(page.getByTestId('option-0')).toBeVisible();

  expect(
    diagnostics.apiRequests.length,
    `expected a session-creation request\n${diagnosticReport(diagnostics)}`,
  ).toBeGreaterThan(0);
  expect(diagnostics.failedRequests, diagnosticReport(diagnostics)).toEqual([]);
});
```

- [ ] **Step 12: Run it — the gate**

```bash
npm run e2e
```

Expected: 1 passing test. Playwright starts both servers, builds the export, and drives
Chromium to the first question.

If it fails, read the attached diagnostic report before changing anything:

- **Zero API requests** → the bundle has the wrong `EXPO_PUBLIC_API_URL`. Confirm with
  `grep -ro 'localhost:3001' apps/mobile/dist/_expo | wc -l` (expect ≥1) and
  `grep -ro '192\.168' apps/mobile/dist/_expo | wc -l` (expect 0).
- **Failed requests** → the server is not up or CORS is rejecting. Check
  `curl -s http://localhost:3001/health`.
- **`start-button` never visible** → the export or `expo serve` is not serving what is
  expected; open `http://localhost:8081/` by hand.
- **Timeout on the second `webServer`** → the cold export exceeded 300s; raise it and
  record the real number.

- [ ] **Step 13: Verify the root commands still behave**

```bash
npm test
npm run typecheck
```

Expected: `npm test` runs exactly the same tests as before with **no Playwright run and no
browser launch** (proving the `e2e`-not-`test` naming works), and `npm run typecheck` now
also type-checks `e2e/` and is silent.

- [ ] **Step 14: Commit**

```bash
git add e2e package.json apps/mobile/package.json package-lock.json
git commit -m "Add e2e workspace with Playwright and a walking-skeleton test"
```

---

## Task 4: The full happy-path loop

**Files:**
- Create: `e2e/tests/support/text.ts`
- Modify (full rewrite): `e2e/tests/session.spec.ts`

**Interfaces:**
- Consumes: `attachDiagnostics`, `diagnosticReport` (Task 3); every `testID` from Task 2.
- Produces: `stripIsolates(text: string | null): string` from `e2e/tests/support/text.ts`;
  one test replacing the skeleton.

The skeleton proved the pipeline. This replaces it with the real loop: ten questions, then
three assertions that each cross-check an independently computed server value.

**Why option 0 every time.** The test cannot know which option is correct — the server
shuffles them and `correct_option` is not in the DOM. So it clicks a fixed index and learns
the outcome from the banner's `testID`. That makes the tally an *independent* derivation of
the score, which is exactly what gives the final assertion its force, and it needs no
seeded RNG or test-only hook.

- [ ] **Step 1: Write the isolate-stripping helper**

`strings.progressLabel` and `strings.scoreLabel` wrap their text in U+2066/U+2069 to stop
Android reordering `1 / 10` under RTL. Those characters reach the DOM (verified), so
`toHaveText('1 / 10')` fails against the real text node.

Create `e2e/tests/support/text.ts`:

```ts
/** U+2066 LEFT-TO-RIGHT ISOLATE, U+2069 POP DIRECTIONAL ISOLATE. */
const ISOLATE_CHARS = /[⁦⁩]/g;

/**
 * strings.ts wraps bidirectional-ambiguous labels ("1 / 10") in Unicode
 * isolates so Android does not render them reversed under RTL. They are
 * invisible but present in textContent, so every comparison against a
 * human-readable string has to remove them first.
 */
export function stripIsolates(text: string | null): string {
  return (text ?? '').replace(ISOLATE_CHARS, '').trim();
}
```

- [ ] **Step 2: Write the full test**

Replace the entire contents of `e2e/tests/session.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { stripIsolates } from './support/text';

const SESSION_LENGTH = 10;
const CHOSEN_OPTION = 0;

// Ten server round trips plus a build-free page load; comfortably inside this,
// but well above the 30s default.
test.setTimeout(120_000);

test('a full session scores exactly the answers given', async ({ page }) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);

  await page.goto('/');
  await expect(page.getByTestId('start-button'), `home never rendered\n${report()}`).toBeVisible();
  await page.getByTestId('start-button').click();

  let expectedCorrect = 0;
  const prompts: string[] = [];

  for (let position = 1; position <= SESSION_LENGTH; position++) {
    // Waiting on the counter, not on an option being visible: the previous
    // question's options stay mounted while the banner is up, so "an option is
    // visible" is continuously true and would let the loop click the same
    // question twice. The counter changes exactly once per advance.
    await expect(
      page.getByTestId('progress-label'),
      `never reached question ${position}\n${report()}`,
    ).toHaveText(new RegExp(`${position}\\s*/\\s*${SESSION_LENGTH}`));

    prompts.push(stripIsolates(await page.getByTestId('question-prompt').textContent()));

    await page.getByTestId(`option-${CHOSEN_OPTION}`).click();

    // Exactly one of these two mounts, and which one tells us whether the
    // fixed choice happened to be right.
    const correctBanner = page.getByTestId('feedback-correct');
    const wrongBanner = page.getByTestId('feedback-wrong');
    await expect(
      correctBanner.or(wrongBanner),
      `no feedback after answering question ${position}\n${report()}`,
    ).toBeVisible();

    if (await correctBanner.isVisible()) expectedCorrect++;

    await page.getByTestId('continue-button').click();
  }

  // 1. The server's score.correct against ten independent UI observations.
  await expect(
    page.getByTestId('results-score'),
    `results screen never rendered\n${report()}`,
  ).toBeVisible();
  expect(
    stripIsolates(await page.getByTestId('results-score').textContent()),
    `score disagreed with the ${expectedCorrect} correct answer(s) observed\n${report()}`,
  ).toBe(`${expectedCorrect} / ${SESSION_LENGTH}`);

  // 2. missed_questions comes from a different core function (missed, not
  //    score) over the same answers, so this catches a bug in one that the
  //    other would hide.
  await expect(page.getByTestId('missed-row')).toHaveCount(SESSION_LENGTH - expectedCorrect);

  // 3. The counter cannot detect a re-served question: an idempotency bug that
  //    replayed one would still advance it. Distinct prompts can.
  expect(new Set(prompts).size, `a question was served twice: ${prompts.join(', ')}`).toBe(
    SESSION_LENGTH,
  );

  expect(diagnostics.failedRequests, report()).toEqual([]);
});
```

- [ ] **Step 3: Run it**

```bash
npm run e2e
```

Expected: 1 passing test. The score varies run to run (option 0 is correct roughly a
quarter of the time) — that is by design; the invariant is that the displayed score matches
what was actually answered, not that it equals any particular number.

- [ ] **Step 4: Prove the assertions can actually fail**

A test that has never failed is not known to test anything. Verify the strongest assertion
is really load-bearing by temporarily breaking the server's scoring:

In `apps/server/src/session.ts`, inside `sessionScore`, temporarily return a wrong value:

```ts
export function sessionScore(record: SessionRecord): Score {
  return { correct: 999, total: record.questions.length };   // TEMPORARY
}
```

```bash
npm run e2e
```

Expected: FAIL on the score assertion, with a message naming the number of correct answers
observed. **Then revert the change** and re-run to confirm green:

```bash
git checkout apps/server/src/session.ts
npm run e2e
```

Expected: passing again. Do not commit until this revert is confirmed.

- [ ] **Step 5: Confirm the missed-list assertion is exercised, not vacuous**

The second assertion only means something if the missed list is usually non-empty. Run the
suite twice and confirm the score is below 10 at least once:

```bash
npm run e2e 2>&1 | tail -5
npm run e2e 2>&1 | tail -5
```

Expected: passing both times. If the score were 10/10 on every run, options would not be
shuffling and that itself is a bug worth chasing — `missed-row` would be asserting
`toHaveCount(0)` forever and covering nothing.

- [ ] **Step 6: Full verification**

```bash
npm test
npm run typecheck
npm run e2e
```

Expected: all three clean, and `npm test` still launches no browser.

- [ ] **Step 7: Commit**

```bash
git add e2e/tests
git commit -m "Add full happy-path E2E test with score, missed-count and distinctness checks"
```

---

## Task 5: Document it

**Files:**
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add the E2E section to the README**

In `README.md`, replace the `## Checks` section with:

````markdown
## Checks

```bash
npm test          # every workspace, including apps/server's real-HTTP integration test
npm run typecheck # every workspace
```

## End-to-end test

One Playwright test drives a real Chromium through a complete ten-question session against
the real server, asserting the score matches the answers given.

```bash
npx playwright install chromium   # one time per machine, ~150MB
npm run e2e
```

It needs no servers running first — Playwright starts both itself: `apps/server`, and a
static web export of the app served on port 8081. It builds that export on every run
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
````

- [ ] **Step 2: Verify the documented commands work verbatim**

Run exactly what the README now tells a newcomer to run:

```bash
npm run e2e
```

Expected: passing. If the README and reality disagree, fix the README.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the E2E suite and why it builds a static export"
```

---
