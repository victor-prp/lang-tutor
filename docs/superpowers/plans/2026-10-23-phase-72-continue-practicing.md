# Phase 72 — Continue practising from a target session's results: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Victor: `continue till PR`, inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A target session's results screen shows the home card's readiness and today's line, and its continue button opens the target's next session without passing through home.

**Architecture:** The session read gains an optional `target_id` (server → core schema → `useSession`). The results screen reads the targets list (`useTargets`), draws `Readiness` and `Sessions` from `TargetCard.tsx`, and presses through the same target-press logic home uses, now in a shared hook, replacing itself with the session screen.

**Tech Stack:** Hono + Drizzle server, Zod wire contract in `packages/core`, Expo Router / React Native app, Jest, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-23-lang-tutor-phase-72-continue-practicing-design.md`

## Global Constraints

- `target_id` on the session view is optional and additive: no `API_LEVEL` change (ADR 0012).
- UI copy is Hebrew only; the new string is exactly `'להמשיך לתרגל'`.
- New testIDs: `results-target` (the block), `results-continue` (the button). `results-next-session` stays the main path's.
- ADR 0002: no new optional or defaulted collaborator parameters; hooks receive what they need.
- Home's behaviour does not change (spec D6, D7).

## Review Focus

- The targets read lands after the learner already tapped "סיום": no navigation or state write after the screen is gone (results only acts on a press).
- A stale stock on continue: create answers `preparing`; the button shows preparing and polling makes it pressable again (e2e taps until the counter shows, as `practice-more.spec.ts` does).
- The target ended between the session and the read (not in the list): no block, `results-next-session` goes home as today (unit test on `resultsTarget`).
- Double tap on continue sends one create (the hook's `run` guard; covered by reuse of home's `run` pattern).
- Back from the next session lands on home, not on an old results screen (e2e asserts it).

---

### Task 1: The session read names its target

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`SessionViewSchema`)
- Modify: `apps/server/src/domain/session.ts` (`SessionRecord`), `apps/server/src/repo/sessions.ts` (`loadSession`), `apps/server/src/routes/sessions.ts` (`sessionView`)
- Test: `apps/server/tests/integration/routes/sessions.test.ts` (describe `'a target path on create and current'`)

**Interfaces:**
- Produces: `SessionView.target_id?: string` on `GET /api/sessions/{id}`; `SessionRecord.target_id?: string` (set only when `sessions.target_id` is not null).

- [ ] **Step 1: Failing test** `"names a target path's session's target on GET /api/sessions/:id, and no target for the main path's"`: create on `target_id: target` (`targetOf('u_1', '2099-01-01')`), `GET /api/sessions/${session_id}` → `body.target_id === target`; `startSeed(app, E())` view → `'target_id' in view === false`.
- [ ] **Step 2: Run** `npm run test:integration -- --selectProjects=integration --runTestsByPath tests/integration/routes/sessions.test.ts` from the repo root → FAIL on `target_id`.
- [ ] **Step 3: Implement** `target_id: z.string().min(1).optional()` on `SessionViewSchema` with a phase 72 comment; `loadSession` selects `sessions.targetId` and returns `...(targetId ? { target_id: targetId } : {})`; `sessionView` spreads `...(result.target_id ? { target_id: result.target_id } : {})`.
- [ ] **Step 4: Run** the test again → PASS; `npm run typecheck` (or the workspace's tsc) → clean.
- [ ] **Step 5: Commit** `feat(server): the session read names its target (phase 72 D1)`.

### Task 2: The app keeps the target, and the pure rules of the block and button

**Files:**
- Modify: `apps/mobile/src/quiz.ts` (`QuizState`, `enteredState`, `resumed`), `apps/mobile/src/hooks/useSession.tsx` (`SessionValue.targetId`)
- Modify: `apps/mobile/src/targets.ts`, `apps/mobile/src/strings.ts`
- Test: `apps/mobile/src/quiz.test.ts`, `apps/mobile/src/targets.test.ts`

**Interfaces:**
- Produces: `QuizState.targetId: string | null`; `SessionValue.targetId: string | null`.
- Produces: `resultsTarget(targetId: string | null, read: 'reading' | 'failed' | TargetList): { kind: 'none' } | { kind: 'reading' } | { kind: 'target'; target: TargetSummary }` — none for no target id, a failed read, or a target not in the list.
- Produces: `continueButton(target: TargetSummary): { label: string; filled: boolean }` — label `strings.continuePractising` when `today.state === 'owed'`, else `targetCardState(target).button ?? strings.practiceMore`; `filled = targetButtonSolid(target)`.
- Produces: `strings.continuePractising = 'להמשיך לתרגל'`.

- [ ] **Step 1: Failing tests.** `quiz.test.ts`: `enteredState('s').targetId === null`; `resumed(enteredState('s'), view({ target_id: 't' })).targetId === 't'`; a view without it → `null`. `targets.test.ts`: `resultsTarget(null, list)` → none; `('t', 'reading')` → reading; `('t', 'failed')` → none; `('gone', list)` → none; `('t', list)` → target t. `continueButton`: owed → `'להמשיך לתרגל'`, filled; done → `'לתרגל עוד'`, pale; rest → `'לתרגל עוד'`, pale; due_today with a word short → `'חזרה אחרונה'`, filled.
- [ ] **Step 2: Run** `npx jest src/quiz.test.ts src/targets.test.ts` in `apps/mobile` → FAIL.
- [ ] **Step 3: Implement** the three exports and the state field (`enteredState` null, `resumed` from `view.target_id ?? null`); `useSession` exposes `targetId: state?.targetId ?? null`.
- [ ] **Step 4: Run** → PASS; mobile tsc clean.
- [ ] **Step 5: Commit** `feat(mobile): a session keeps its target; results block and button rules (phase 72 D1-D3)`.

### Task 3: One target press for home and results

**Files:**
- Create: `apps/mobile/src/hooks/usePracticeTarget.tsx`
- Modify: `apps/mobile/src/components/LearningSection.tsx`, `apps/mobile/src/components/PracticeMoreSheet.tsx`

**Interfaces:**
- Produces: `usePracticeTarget({ run, openSession }: { run: (work: () => Promise<void>) => Promise<void>; openSession: (sessionId: string, fresh: boolean) => void }) => { practice(target: TargetSummary): void; asking: boolean; answerAsk(stopAsking: boolean, start: boolean): void; cancelAsk(): void }` — `practiceTarget`, `startTarget`, `answerAsk` and the `asking` state moved verbatim from `LearningSection`; `cancelAsk` closes the sheet and saves nothing.
- Produces: `PracticeMoreSheet` gains a required `onCancel: () => void`, called by a tap outside and Android back (instead of `onLater(false)`).

- [ ] **Step 1: Move** the logic into the hook; `LearningSection` calls it with its own `run` and `enterSession` (which pushes `/session`), and renders the sheet with `onLater={(stop) => answerAsk(stop, false)}`, `onAnyway={(stop) => answerAsk(stop, true)}`, `onCancel={cancelAsk}`.
- [ ] **Step 2: Run** `npx jest` in `apps/mobile` and mobile tsc → PASS (pure tests unchanged). Home's behaviour is proven by the existing e2e (`targets.spec.ts`, `practice-more.spec.ts`) in Task 5.
- [ ] **Step 3: Commit** `refactor(mobile): the target press in one hook, the sheet's cancel apart (phase 72 D4, D6)`.

### Task 4: The results screen of a target session

**Files:**
- Modify: `apps/mobile/src/app/results.tsx`

**Interfaces:**
- Consumes: `session.targetId` (Task 2), `resultsTarget`, `continueButton` (Task 2), `usePracticeTarget` (Task 3), `useTargets().reload`, `Readiness`, `Sessions` from `TargetCard.tsx`, `shouldPollTargets`, `POLL_INTERVAL_MS`, `targetSessionAction`, `useNextSession().start`.

- [ ] **Step 1: Implement.** Hold the finished session's view (score, lists) from the first render so `enter` of the next does not redraw it. When `targetId` is set: read the targets on focus, poll while `shouldPollTargets` and focused, and with `resultsTarget(...)`:
  - `target`: under the score a white block `testID="results-target"` with the countdown title, `<Readiness>`, `<Sessions>`; the primary button `testID="results-continue"` with `continueButton(target)`'s label and look, showing home's preparing look (disabled, spinner, `strings.preparingQuestions`) for a `preparing` action and home's failed note and retry label for `failed`; its press is `practice(target)`. `openSession(id, fresh)`: `if (fresh) void next.start(id); enter(id); router.replace('/session')`.
  - `reading`: the block's space empty, `results-continue` disabled.
  - `none`: today's screen (`results-next-session` → home).
  - The sheet: `onLater={(stop) => { answerAsk(stop, false); router.dismissTo('/'); }}`, `onAnyway={(stop) => answerAsk(stop, true)}`, `onCancel={cancelAsk}`.
  - `run`: the same one-at-a-time guard as home's, with `target closed` → `router.dismissTo('/')` and `not enough questions` → home's alert.
- [ ] **Step 2: Run** mobile tsc and `npx jest` → clean; `npm run lint:arch` → clean.
- [ ] **Step 3: Commit** `feat(mobile): a target session's results show the card and continue to the next (phase 72 D2-D5)`.

### Task 5: e2e

**Files:**
- Create: `e2e/tests/continue-practising.spec.ts`
- Modify: `e2e/tests/targets.spec.ts` (`backHome`), `e2e/tests/practice-more.spec.ts` (`playAndReturn`) → tap `results-done`

- [ ] **Step 1: Write** the spec, with `practice-more.spec.ts`'s fixtures (`signUpLearner`, `skipSeed`, `createTarget`, `withVoices(page, [])`, `playSessionRight`, `readyPathSession`): a homework of two words → play its first session → `results-target` shows the readiness and today's line, and each equals the home card's for the same target after `results-done` (read the values within `results-target`, then compare on home) → second run: from results, tap `results-continue` until `session-counter`-style progress is visible (look first, tap briefly, as `tapCardUntil`) and assert home's target card was never visible in between (the URL goes `/results` → `/session`) → back from the session lands on home. A second test: the one-word homework done for today (as `practice-more.spec.ts`) → `results-continue` opens `practice-more-sheet` → "אחזור מחר" lands on home.
- [ ] **Step 2: Run** `npm run e2e -- tests/continue-practising` then `tests/targets` and `tests/practice-more` → PASS. Remove `e2e/test-results` afterwards (ADR 0006 R2 in the Stop hook).
- [ ] **Step 3: Commit** `test(e2e): continue practising from a target session's results (phase 72)`.

### Finish

- [ ] `npm test`, `npm run test:all`, `npm run lint:arch` green; push; `git-create-pr`; `ci-green`.
