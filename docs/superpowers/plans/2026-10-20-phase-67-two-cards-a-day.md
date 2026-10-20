# Phase 67 — Two cards a day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A target's day is steered by readiness at the start of the day: two cards a day for each word below 90, one per counted skill on the eve plus a check for ready words, new words split at most 8 a day; the budget is the exact play of that picker.

**Architecture:** `targetDay` keeps its output shape (`TargetDay`, `WordDay`) so every consumer stays; its input swaps the meter's rows and "right today" for start-of-day skill chances and the cards asked today. The picker reads the new `WordDay` fields; the budget plays it forward with no miss stretch. The meter (`target_skills`) is still written at session end and read by nothing that steers.

**Tech Stack:** TypeScript, Jest (server unit + integration), Playwright e2e, Expo app.

**Spec:** `docs/superpowers/specs/2026-10-20-lang-tutor-phase-67-two-cards-a-day-design.md`

## Global Constraints

- `domain/` stays pure: imports `@lang-tutor/core/*` only, no clock or random (ADR 0001 R3).
- `READINESS_WORD_READY` (90) is the ready line; `READY_ON_DUE_PASS` is never lowered.
- New words a day at most: `NEW_TARGET_WORDS_PER_DAY = 8` (Victor's number).
- The wire is unchanged: no `API_LEVEL` bump. UI copy is Hebrew.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run tests directly (`npx jest <path>` from `apps/server`), not through a `bash -c` wrapper.

## Review Focus

1. A word that cannot be said (speaking not live): homework counts two skills, so the eve asks two cards, not three. (Task 1 test)
2. A device that cannot listen: spelling's dictation falls back to typed in `planCards`; the plan still counts it as spelling. (Task 2 test)
3. Cards of the session in flight and of practice-more sessions count as asked today: nothing is asked twice on one skill while another is open. (Task 1 and 2 tests)
4. A known word (main-path memory) joining a target already ready: it rests until the eve and is started by its check card. (Task 1 test)
5. A word added after the halfway day, and a date moved earlier: owed at once, the eve takes every unmet word. (Task 1 test)

---

### Task 1: The day, from readiness

**Files:**
- Modify: `apps/server/src/domain/targetDay.ts`, `apps/server/src/domain/targetSummary.ts`, `apps/server/src/domain/chooseConstants.ts`
- Test: `apps/server/src/domain/targetDay.test.ts` (rewritten), `apps/server/src/domain/targetSummary.test.ts` (add `skillStarts`)

**Interfaces:**
- Produces, in `targetDay.ts`:
  - `servedSkill(type: QuestionType): Dimension | null` — writing for translate, gap, sentence, letter tiles, reverse choice, cloze choice; spelling for dictation; speaking for say translation; else null.
  - `type SkillStart = { glossId: string; dimension: Dimension; chance: number; movedOn: string | null }`
  - `type TargetDayInput = { today; createdOn; dueOn; kind: ReadinessKind; words: readonly TargetWordInput[]; starts: readonly SkillStart[]; askedToday: readonly { glossId: string; type: QuestionType }[]; answeredToday: boolean }`
  - `WordDay` = `{ glossId; state; toStart; owed: Dimension[]; open: Dimension[]; cardsLeft: number; counted: { dimension: Dimension; chance: number }[]; readinessPct: number; startsIn: number | null }` (`checks` and the meter's `skills` go). `owed = open.slice(0, cardsLeft)`; `open` = counted skills not asked today, by start chance, then `movedOn` (null first), then writing, spelling, speaking.
  - `TargetDay` unchanged in shape; `readinessPct`/`readyCount` read start chances; `capHalves = capHalves(daysLeft)`.
  - `targetDay(input: TargetDayInput): TargetDay`
- Produces, in `targetSummary.ts`: `skillStarts(input: { kind; dueOn; words: { glossId; live }[]; rows; memory; firstToday }): SkillStart[]` — the start chance `readinessSummary` already computes per counted skill (`firstToday.before`, else the row's or main memory's chance), `movedOn` = the row's `day`, else the memory's `lastDay`, else null. `readinessSummary` reuses it.
- In `chooseConstants.ts`: `NEW_TARGET_WORDS_PER_DAY = 8`.

- [ ] **Step 1: Write the failing tests** in `targetDay.test.ts`, one `it` each:
  - below 90 before the eve: `cardsLeft` 2, `owed` = the two lowest start chances; ready: `cardsLeft` 0, state `done`;
  - the eve (`daysLeft` 1): below 90 → 3 for homework, 2 for an exam, 2 for a homework word without speaking; ready → 1;
  - asked today (answers or in flight passed as `askedToday`): a typed card and a say card leave nothing on a non-eve day; two typed cards count once;
  - the tie-break: equal chances → `movedOn` null first, then writing, spelling, speaking;
  - the quota, 15 words: created 5 days ahead → 5 on day one, 5, 5; 2 days → 8 then 7; due tomorrow → 15; words started today count toward it; a word added past halfway is in today's quota; `startsIn` of a later word;
  - a known word ready on joining: `done`, never `toStart` before the eve; on the eve `toStart` with `cardsLeft` 1;
  - states: `extra` for a word started today past the quota; day `rest` when nothing owed and no answer; `due_today` on the date with no word owed; `nextPracticeIn` 1 while a word is below 90 or unmet, `daysLeft − 1` when all are ready, null on the eve.
  - `skillStarts`: `firstToday.before` wins over the row; no row → main memory's chance and `lastDay`; nothing → chance 0, `movedOn` null.
- [ ] **Step 2: Run them, expect failures:** `npx jest src/domain/targetDay.test.ts src/domain/targetSummary.test.ts` → FAIL (new input type).
- [ ] **Step 3: Implement** `servedSkill`, `skillStarts`, `targetDay`. The quota: `total = max(1, daysBetween(createdOn, dueOn))`, `half = ceil(total / 2)`, `meeting = max(1, daysLeft − half + 1)`, `quota = daysLeft <= 1 ? pool : min(NEW_TARGET_WORDS_PER_DAY, ceil(pool / meeting))`, `pool` = words unstarted or started today, in plan order (added, then gloss); the first `quota` of the pool are planned. Cards a planned word needs: eve → ready ? 1 : counted; else ready ? 0 : min(2, counted); `cardsLeft = max(0, need − asked)`, asked = distinct counted skills served today. `toStart` = planned, unstarted, `cardsLeft > 0`.
- [ ] **Step 4: Run them, expect PASS.**
- [ ] **Step 5: Commit** `feat(server): phase 67 a target's day from readiness at the start of the day`.

### Task 2: The picker reads the new day

**Files:**
- Modify: `apps/server/src/domain/targetPicker.ts`, `apps/server/src/domain/chooseConstants.ts` (remove `TARGET_SPEAKING_PER_SESSION`)
- Test: `apps/server/src/domain/targetPicker.test.ts` (rewritten where it reads the meter)

**Interfaces:**
- Consumes: Task 1's `WordDay`, `servedSkill`.
- Produces: `chooseTargetPicks(input: TargetPickInput): ChosenPick[]` (signature unchanged). In-flight cards are credited by `servedSkill`: they leave `open` and lower `cardsLeft`; a word in flight is no longer `toStart`. Rung: writing 2, spelling 1, speaking 2.

- [ ] **Step 1: Failing tests:** starts first (two ladders a session at most; a known word's recall card on its first owed skill; a new meaning's new_meaning card); then each owed word's first card, then its second, lowest `readinessPct` first; two picks a word; ten slots; 15 owed say cards fit in two sessions (no speaking cap); in-flight credit; practice more starts the next later words then one card per word on its lowest-chance counted skill; `last_review` asks one card per word; `past_budget` asks owed first. `planCards` on a pick for spelling without listening gives a typed card.
- [ ] **Step 2: Run, expect FAIL:** `npx jest src/domain/targetPicker.test.ts`.
- [ ] **Step 3: Implement:** replace `belowCapWork`, `checkWork` and `hardest`'s meter reads with the word's `owed` queue and `counted` chances; drop the speaking counter.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(server): phase 67 the target picker asks each word's cards of the day, no speaking cap`.

### Task 3: The budget is the exact play

**Files:**
- Modify: `apps/server/src/domain/targetBudget.ts`, `apps/server/src/services/targetDayRead.ts` (`readTodayBudget`, `enrollmentReads`)
- Test: `apps/server/src/domain/targetBudget.test.ts`

**Interfaces:**
- Consumes: Task 1's `TargetDayInput`, Task 2's picker.
- Produces: `playTodayForward(input: { pick: Omit<TargetPickInput, 'day' | 'mode' | 'inFlight'> } & TargetDayInput): { sessions: number; cards: number }` — each session's cards appended to `askedToday`, its words started. `budgetSessions`, `missRateOf`, `DEFAULT_MISS_RATE`, `MISS_RATE_*`, `MISS_RATE_CAP` and `enrollmentReads().missRate` go. `readTodayBudget` writes `sessions = play.sessions + doneBefore`, `missRoom = 0`.

- [ ] **Step 1: Failing tests:** 15 words below 90, 2 days left → the play's sessions equal what the picker makes session by session; a day where all are ready and not the eve → 0; the eve with 15 new words → the ladders' sessions (two a session) and their say and dictation cards.
- [ ] **Step 2: Run, expect FAIL:** `npx jest src/domain/targetBudget.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(server): phase 67 today's budget is the picker's exact play, no miss stretch`.

### Task 4: Wire the reads

**Files:**
- Modify: `apps/server/src/services/targetDayRead.ts` (`readTargetDay`), `apps/server/src/services/sessions.ts`, `apps/server/src/services/targets.ts` where they read removed fields
- Test: `apps/server/src/services/targets.test.ts`, `sessions.test.ts`, `sessions.stock.test.ts`, `sessions.prepare.test.ts`; `tests/support/fakes.ts`, `tests/support/targetRows.ts`

**Interfaces:**
- Consumes: `skillStarts` (Task 1), `targetDay`.
- Produces: `readTargetDay(...)` unchanged signature; its `dayInput` is a `TargetDayInput`: `kind: target.kind`, `starts` from `repos.targetReadiness.findRows([target.id], glossIds)`, `repos.memory.findRows({ enrollmentId, glossIds })`, `repos.targetReadiness.findFirstEventsOn(target.id, today)`; `askedToday` = today's answers on the target's path (`answer.targetId === target.id`).

- [ ] **Step 1:** `npx tsc --noEmit -p apps/server` and fix every reader of `checks`, the meter's `skills` and the miss rate.
- [ ] **Step 2:** Update the service tests that assert the old plan; add one in `targets.test.ts`: a homework at 2 days left whose words read 68–95 offers `ceil(cards / 10)` sessions and lists only the words below 90 as owed.
- [ ] **Step 3:** `npx jest --selectProjects=unit src/services` → PASS.
- [ ] **Step 4: Commit** `feat(server): phase 67 a target's day reads its readiness`.

### Task 5: The day simulation

**Files:**
- Modify: `apps/server/src/domain/day.test.ts`

- [ ] **Step 1:** The runner's `dayInputOf` builds a `TargetDayInput`: `starts` from a snapshot of `readinessRows` taken at each day's start (as `skillStarts` with that day's first events), `askedToday` from the day's answers on the target's path. The runner's meter write stays.
- [ ] **Step 2:** Remove the measures that read the meter's climb (the plan at 100% on the eve, the 2026-10-16 replay's "100% after N sessions", the 3-day exam's "100% only on its eve", the 20-day exam's eve-at-cap, the speaking-cap check of `itKeepsTheTargetPaths`); keep anti-goal 1 (reworded: no card that serves no owed work while work is owed), "never overnight", "never lower after a right", the budget set once, the paths.
- [ ] **Step 3:** Add `describe` blocks for 15-word homeworks given 5 days, 2 days and 1 day ahead, the learner practising the day's budget: report each day's sessions; gate that a day's sessions never exceed its budget and the budget never grows; gate FSRS ready-on-due and readiness on the date at the values measured now, written with the date.
- [ ] **Step 4:** `npx jest src/domain/day.test.ts` → PASS with `READY_ON_DUE_PASS` unchanged. If the 14-day gate fails, fix the rule, never the mark.
- [ ] **Step 5: Commit** `test(server): phase 67 the day simulation plays two cards a day`.

### Task 6: The app, integration and e2e

**Files:**
- Modify: `apps/mobile/src/strings.ts:475` (`targetReadinessName` → `isolateLtr(`${readinessPct}%`)` at every value), its tests; `apps/server/tests/integration/services/sessions.targets.test.ts`; `e2e/tests/targets.spec.ts`, `e2e/tests/practice-more.spec.ts` where they assert the old plan.

- [ ] **Step 1:** Mobile: `npx jest` in `apps/mobile` for the strings and targets tests, updated for "92%" in place of "מוכנה".
- [ ] **Step 2:** `npm run test:integration` from the worktree root; update what asserts the meter's plan or the miss-stretched budget.
- [ ] **Step 3:** `npm run e2e -- tests/targets.spec.ts tests/practice-more.spec.ts`; then the full `npm run e2e`.
- [ ] **Step 4: Commit** per area: `feat(mobile): …`, `test(server): …`, `test(e2e): …`.

### Task 7: Verify and record

- [ ] `npm test`, `npm run test:all`, `npm run lint:arch` from the worktree root → all pass.
- [ ] Rerun `drafts/2026-10-20-target-prep-evidence/` numbers against the build only if the gates moved; write the spec's Rulings with every call made while building (`Ruling:` exactly).
- [ ] Commit `docs(spec): phase 67 rulings made while building`, then finish through `git-create-pr` and `ci-green`.
