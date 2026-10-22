# Phase 71: the eve until ready — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the eve, the target card counts the words still short with one bar per word, the day stays owed while a session can raise the card, and no eve session is the owed work alone (spec Ruling R1).

**Architecture:** Two pure domain changes (the eve's state in `todaySummary`, the eve's full-session rule beside `pastBudget`), wired into the summary and session services; one additive wire field (`word_readiness`); the app draws a words row in place of the sessions row when `days_left === 1`.

**Tech Stack:** TypeScript, Jest, Zod (packages/core), React Native (apps/mobile), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-22-lang-tutor-phase-71-eve-until-ready-design.md`

## Global Constraints

- The eve is `days_left === 1` (server: `daysLeft === 1`). Nothing changes on any other day.
- Copy, exact: strip `${TARGET_THE[kind]} מחר · היום מתרגלים עד שכל המילים מוכנות`; line `עוד ${n} מילים לחזק` / `עוד מילה אחת לחזק`; side `${ready} מתוך ${count} מוכנות`; check line `נשארה בדיקה אחרונה לפני מחר`. Numbers through `isolateLtr`.
- Word bar colours: ready `colors.progress`, short `#84ADFF` on the track `#EAECF0`.
- No API level (spec D8); add a "Not raised by phase 71" note to `apiLevel.ts`.

## Review Focus

- An eve target whose words are all ready but check cards are owed: the check line, a solid button (Task 3 test).
- An eve target with a word that cannot be met (no room for new words) and every met word ready: the plan's state, not owed (Task 1 test, through `canRaise: false`).
- An exam's eve: the strip says "הבוחן מחר · …" (Task 3 test).
- A target with no word on the eve: no row, no bars (Task 3 test).
- A word dropping below its bar after a missed check: the words line comes back (Task 3 test, ready_count < word_count with state owed).

---

### Task 1: The eve in the domain

**Files:**
- Modify: `apps/server/src/domain/targetSummary.ts` (`todaySummary`)
- Modify: `apps/server/src/domain/targetBudget.ts` (new `fullSession`)
- Test: `apps/server/src/domain/targetSummary.test.ts`, `apps/server/src/domain/targetBudget.test.ts`

**Interfaces:**
- Produces: `todaySummary(input: { plan; daysLeft; budget; offer; sessionsDone; canRaise: boolean })`; `fullSession(input: { daysLeft: number; budget: number | null; done: number; inFlight: boolean }): boolean` = `daysLeft === 1 || pastBudget(input)`.

- [ ] Tests: `todaySummary` "on the eve is owed while a session can raise the card, the budget met" (`daysLeft: 1, plan: 'done', budget 5, sessionsDone 5, canRaise: true` → `state: 'owed', endedEarly: false`); "on the eve once nothing can raise it is the plan's" (`canRaise: false`, plan `owed` → owed; plan `done` → done, budget met or not); every existing case passes `canRaise: true` unchanged (it reads only on the eve). `fullSession`: true on the eve with no budget; false at 2 days left with no budget; true past the budget at 2 days left.
- [ ] Run `npx jest --selectProjects=unit --runTestsByPath src/domain/targetSummary.test.ts src/domain/targetBudget.test.ts` from `apps/server`: the new cases fail.
- [ ] Implement both; `todaySummary`'s `endedEarly` is false whenever the state is not `done`.
- [ ] Run the same command: pass. Commit `feat(server): phase 71 the eve is owed while it can rise, and its sessions are full`.

### Task 2: The server serves it

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`TargetSummarySchema.word_readiness: z.array(Percent)`, commented), `packages/core/src/apiLevel.ts` (note)
- Modify: `apps/server/src/services/targets.ts` (`view`: compute `canRaise` before `todaySummary`, pass it; `word_readiness: words.map((word) => word.readiness_pct)`)
- Modify: `apps/server/src/services/sessions.ts` (`readTarget`: `fullSession({ daysLeft: day.daysLeft, budget: budget?.sessions ?? null, done, inFlight })` in place of `pastBudget`)
- Modify: `apps/server/src/domain/day.test.ts` (`chooseFor` uses `fullSession` with the day's days left; a new gate)
- Test: `apps/server/src/services/targets.test.ts`, `apps/server/src/routes/targets.test.ts`, `apps/server/src/openapi.test.ts`, `packages/core/src/api/schemas.test.ts`, `apps/server/tests/integration/routes/targets.test.ts`, the session service's unit test that covers `past_budget`

- [ ] Tests: the summary service on the eve after the budget with a word below its bar reads `state: 'owed'`; `word_readiness` equals the words' `readiness_pct` in order; the session service on the eve with owed work and no budget chooses `past_budget` (records `pastBudget: true`). Fixtures that list a summary's fields gain `word_readiness`.
- [ ] Day simulation gate (new describe, phase 71): a 10-word homework skipped until the eve, then 25 eve sessions, the five phases and a learner who never misses: every target session on the eve before the card reaches 100% fills `SESSION` slots (read the picker's session size constant) — report the counts in the title.
- [ ] Run `npm test` in `apps/server` and `packages/core`, `npx tsc --noEmit -p apps/server` and `-p packages/core`: pass. The phase 67b eve gates still pass.
- [ ] Commit `feat(server): phase 71 the summary's eve and each word's readiness on the list`.

### Task 3: The card's words row

**Files:**
- Modify: `apps/mobile/src/strings.ts` (`targetEveStrip(kind)`, `targetEveWords(missing)`, `targetEveReady(ready, count)`, `targetEveCheck`)
- Modify: `apps/mobile/src/targets.ts` (`urgencyOf` eve text; `sessionsLine` eve branch with kinds `eve_words` and `eve_check`; `sessionDots` none on the eve; new `wordBars(target): { pct: number; ready: boolean }[]`; `sessionsSpoken` eve cases)
- Modify: `apps/mobile/src/components/TargetCard.tsx` (`Sessions` draws the bars, testID `target-word-bar-ready` / `target-word-bar-short`; bold line for `eve_words`; praise testID only for the more/done tones)
- Test: `apps/mobile/src/targets.test.ts`, `apps/mobile/src/strings.test.ts`, `apps/mobile/src/nextSession.test.ts` (fixtures gain `word_readiness`)

- [ ] Tests by table: eve with 7 of 9 short → `eve_words`, "עוד 7 מילים לחזק", side "2 מתוך 9 מוכנות", no dots, bars ready first then by pct; one short → "עוד מילה אחת לחזק"; all ready and owed → `eve_check`; all ready and done → `all_ready`; no word → `none`; two days left → the existing lines; the strip for homework and exam on the eve, the date's unchanged; spoken "עוד 7 מילים לחזק, 2 מתוך 9 מוכנות".
- [ ] Run `npx jest src/targets.test.ts src/strings.test.ts` in `apps/mobile`: fail, then implement, then pass; `npx tsc --noEmit` in `apps/mobile`.
- [ ] Commit `feat(mobile): phase 71 the eve's card counts the words still short`.

### Task 4: e2e

**Files:**
- Modify: `e2e/tests/support/targets.ts` (`SessionsView.bars?: string[]`, `eveOf(target)`), `e2e/tests/targets.spec.ts`, `e2e/tests/practice-more.spec.ts` (each scenario whose target is due tomorrow)

- [ ] Each eve scenario reads the new strip and `eveOf(summary)`: line, side, no dots, bars by kind.
- [ ] Run `npm run e2e -- tests/targets tests/practice-more` from the worktree: pass. Remove `e2e/test-results` after reading.
- [ ] Commit `test(e2e): phase 71 the eve's strip and words row`.

### Task 5: Finish

- [ ] `npm run lint:arch`, every unit suite, typechecks, integration for targets and sessions (`npm run test:integration` scoped), then `superpowers:finishing-a-development-branch` → `git-create-pr` → `ci-green`.
