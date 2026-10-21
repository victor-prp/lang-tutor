# Phase 67b — Readiness that shows the work: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Victor: "go till
> PR", inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the readiness card moves from the first session, counts a word at its bar as 100%,
never drops for later answers before the eve, rewards every eve answer, and its line and sheet say
whether another session can raise it.

**Architecture:** the rules live in `packages/core` readiness (pure); the server's domain reads
them (summary, picker); services pass readiness "now" to the picker and compute the "can raise"
flag; the app draws the line from the summary. No migration: `bonus_used` stops counting at 2.

**Tech stack:** TypeScript, Jest (unit / integration buckets, ADR 0004), Expo app, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-21-lang-tutor-phase-67b-readiness-shows-the-work-design.md`

## Global constraints

- Hebrew copy verbatim from spec D7–D9 (the strings below are copied from it).
- `READINESS_WORD_READY` (90) still steers the plan for both kinds; the card's bars are homework
  90, test 95.
- `READY_ON_DUE_PASS` is never lowered; a scenario below it is a ruling for Victor (spec Testing).
- Domain stays pure (ADR 0001); no port or database name hardcoded (ADR 0006).
- Write rulings as `Ruling:` lines in the spec's Rulings section (memory: ledger-rulings-grep).

## Review focus

1. A word whose main memory moved earlier today and has no readiness row yet: its first target
   answer today must count (`readinessFromMemory` sets `day` to the memory's last day). Test in
   Task 1: a row read from memory last moved today is treated as the day's first answer.
2. A word that cannot be said (speaking not live): no say card after its ladder (Task 3 test).
3. The eve with the day's new-word room used up and only unmet words below the bar: the flag must
   say "cannot raise" (Task 2 test, `newRoom: 0`).
4. A rest day at 100%: the card reads "עשית את זה! ✓", not the rest line alone (Task 4 test).
5. One session in the day's goal: "היעד של היום: תרגול אחד", never "1 תרגולים" (Task 4 test).

---

### Task 1: Core readiness rules (spec D1, D2, D3)

**Files:** modify `packages/core/src/domain/readiness.ts`, `packages/core/src/domain/index.ts`;
test `packages/core/src/domain/readiness.test.ts`, `readiness.replay.test.ts` (re-measure).

**Produces:**
- `wordChance(chances: readonly number[]): number` → the minimum (0 for none).
- `READINESS_CARD_BAR: Record<ReadinessKind, number>` = `{ homework: 90, exam: 95 }`.
- `cardWordPct(pct: number, kind: ReadinessKind): number` → 100 at or above the bar, else `pct`.
- `cardPct(wordPcts: readonly number[], kind: ReadinessKind): number` → floor of the mean of
  `cardWordPct` (0 for none).
- `READINESS_BONUS_PER_DAY` renamed `READINESS_BONUS_RECORDED` (= 2): `bonusUsed` stops at it.
- `applyReadiness` (same signature): days left = due − day. A first answer of the day (no row, or
  `row.day !== day`) as now. A later answer: days left > 1 → `null`; days left = 1 → a miss as now
  (once a day), a right → `withBonus` with no limit, `held: false`, `bonusUsed` min(+1, 2).

- [ ] Write failing tests: min of chances; `cardWordPct(89,'homework')=89`, `(90,'homework')=100`,
  `(94,'exam')=94`, `(95,'exam')=100`; `cardPct([92,50],'homework')=75`; before the eve a later
  right and a later miss return `null`; on the eve 5 rights in a row each raise the chance; a cold
  miss on the eve then a right sets `held` false; `bonusUsed` never passes 2; Review focus 1.
- [ ] Run `npx jest --selectProjects=unit --runTestsByPath packages/core/src/domain/readiness.test.ts`: FAIL.
- [ ] Implement; export the new names from `index.ts`; replace every `READINESS_BONUS_PER_DAY` use.
- [ ] Re-run: PASS. Re-measure `readiness.replay.test.ts` marks with today's date in a comment.
- [ ] Commit `feat(core): phase 67b readiness: weakest skill, card bar, first answers before the eve`.

### Task 2: Summary, the "can raise" flag and the wire (spec D2, D6)

**Files:** `apps/server/src/domain/targetSummary.ts` (+ test), `apps/server/src/services/targets.ts`
(+ `services/targets.test.ts`, `routes/targets.test.ts`, `openapi.test.ts`),
`packages/core/src/api/schemas.ts` (+ `schemas.test.ts`) for the field's description.

**Consumes:** Task 1. **Produces:**
- `readinessSummary(...)` (same input): `readinessPct`, `readinessStartPct` = `cardPct`;
  `readyCount` = words at the kind's bar; each word's `readinessPct` = `cardWordPct`; each word
  gains `unansweredToday: number` (counted skills with no row moved `today`).
- `canRaiseToday(input: { daysLeft: number; newRoom: number; words: readonly { readinessPct: number; met: boolean; unansweredToday: number }[] }): boolean`
  → `daysLeft >= 1` and some word below 100 with: not met and `newRoom > 0`; or `daysLeft === 1`;
  or `unansweredToday > 0`. Replaces `asksBeforePracticeMore`.
- Wire: `practice_more_little = !canRaiseToday(...)`; `newRoom` = `DAY_NEW_CAP` − today's
  introduced (`shared.introduced()`); `met` = day word state not `later` and not `toStart`.

- [ ] Failing tests: the card value and ready count at 90 / 95; `unansweredToday`; the flag by
  table (unmet with room, unmet without room = false, unanswered skill, the eve, all answered, all
  at 100%).
- [ ] Implement; update the service, its tests and the schema description.
- [ ] `npm test` in `apps/server` and `packages/core`: PASS. Commit `feat(server): phase 67b card value and the can-raise flag`.

### Task 3: The picker (spec D4, D5)

**Files:** `apps/server/src/domain/targetPicker.ts` (+ test), `apps/server/src/services/targetDayRead.ts`,
`apps/server/src/domain/targetSummary.ts`.

**Produces:**
- `TargetPickInput.now?: ReadonlyMap<string, { pct: number; counted: readonly Dimension[] }>` —
  per word its card value now and its counted skills, lowest chance now first.
- `pickNow(words: readonly WordReadiness[]): Map<…>` in `targetSummary.ts` (skills sorted by
  `chance`).
- `readTargetPickInput` reads the target's readiness rows and passes `now` (via `readinessSummary`
  over the day's words and live skills).
- Picker: after the starts, a word met by its ladder this session whose practised skills hold
  `spoken_productive` gets a `spoken_productive` rung-2 pick if `open(word, 1)` — in `owed`,
  `past_budget` and `more`. `hardest` orders by `now.pct` (then as before) and asks
  `now.counted[0]`; without `now`, as before.

- [ ] Failing tests: two ladders plus their two say picks fill a session; none when speaking is not
  live; the say pick in a practice-more start; `hardest` asks the word lowest now first and its
  counted skill weakest now, never speaking on an exam.
- [ ] Implement; `targetBudget.test.ts` and `targetDay.test.ts` updated where a new word's second
  card moved into its first session. PASS. Commit `feat(server): phase 67b say card in the meeting session, practice more by readiness now`.

### Task 4: The app (spec D7, D8, D9)

**Files:** `apps/mobile/src/strings.ts` (+ `strings.test.ts`), `apps/mobile/src/targets.ts`
(+ `targets.test.ts`, `nextSession.test.ts`), `components/TargetCard.tsx`,
`components/PracticeMoreSheet.tsx`, `app/targets/[id].tsx`.

**Produces:** `SessionsLine` = `{ kind: 'offer' | 'progress' | 'one_left' | 'met_more' | 'met_done' | 'all_ready' | 'early' | 'rest' | 'none'; text; sub: string | null; tone: 'plain' | 'more' | 'done'; side }`.

| Kind | When | text · sub | tone |
|---|---|---|---|
| offer | owed, 0 done | "היעד של היום: N תרגולים" (1: "…: תרגול אחד") · side "כ-M דקות" | plain |
| progress | owed, ≥1 done, ≥2 left | "התחלה טובה · עוד N ליעד של היום" | plain |
| one_left | owed, 1 left | "כמעט שם · עוד תרגול אחד" | plain |
| all_ready | done, early or rest, card 100 | "עשית את זה! ✓" | done |
| met_more | done or early, `!practice_more_little` | "עשית עבודה טובה להיום ↑" · "עוד כמה תרגולים יחזקו עוד יותר" | more |
| met_done | done or early, `practice_more_little` | "עשית עבודה מצוינת להיום ✓" · "מחר נחזק עוד" | done |

- Side: bonus "+N בונוס" in the met kinds, "N במקום M" when ended early; none on progress lines.
- `tone` colours: plain `#344054`, more `colors.primary`, done `colors.correct`; text bold for more
  and done; `sub` 13 px under the text in the same colour.
- `askBeforePracticeMore`: state done, `practice_more_little`, card below 100, not opted out.
- `withoutWord`: a word counts as ready when `readiness_pct >= READINESS_CARD_BAR[kind]`.
- Strings: the sheet title "עשית עבודה מצוינת להיום", text "עוד תרגול היום לא יתרום הרבה";
  `targetGroupTitle.done` "תורגלו היום"; `targetNotReady`: `${TARGET_THE[kind]} ${מחר|היום} ו-N
  מילים צריכות חיזוק` / "…ומילה אחת צריכה חיזוק", no second sentence. Screen reader: the line's text, then the
  count as now.

- [ ] Failing tests for each row above and Review focus 4–5; then implement; `npm test` in
  `apps/mobile`: PASS. Commit `feat(mobile): phase 67b the card's line, sheet and strip words`.

### Task 5: The day simulation (spec Testing)

**Files:** `apps/server/src/domain/day.test.ts`.

- `runPaths` options gain `extraAfterDone?: number` (that many practice-more sessions once the day
  owes nothing, on `{ untilDone }` days) and `moreWhenDone?: boolean` (on a fixed-count day, a
  session with nothing owed is the target's practice more, not My words). `pickInputOf` passes
  `now` (Task 3's `pickNow` over `readinessSummary`). The spike's `spike.diff` (evidence folder)
  shows both.
- New gated scenarios, marks measured once and dated:
  1. 18-word homework due in 5 days, budget only: the card above 0 after the first session.
  2. 18-word test and homework due in 5 days at 5, 10, 15 sessions a day: before the eve, the
     five-phase mean of each day's end is never more than 1 point lower with more sessions; per
     phase reported.
  3. The same two at 10 a day then up to 40 eve sessions: 100% on the eve in every phase whose
     rhythm does not pin one word (a phase left out is named with its reason).
  4. The test crammed at 15 a day: day 2's end at or below its mark.
- Existing scenarios: re-measure `HOMEWORK_PASS` and the phase 67 measures; `READY_ON_DUE_PASS`
  unchanged.

- [ ] Run `npx jest --selectProjects=unit --runTestsByPath apps/server/src/domain/day.test.ts`;
  measure; write marks; PASS. Commit `test(server): phase 67b day simulation`.

### Task 6: Integration, e2e, and the PR

- [ ] `apps/server/tests/integration/routes/targets.test.ts` and other integration tests reading the
  flag or the card value: updated; `npm run test:all`.
- [ ] e2e: `e2e/tests/practice-more.spec.ts`, `targets.spec.ts`, `support/targets.ts` for the new
  words and the sheet only when nothing can raise the card; `npm run e2e -- tests/practice-more`
  and `tests/targets` (memory: e2e filter needs `tests/<name>`), then `npm run e2e`; delete
  `e2e/test-results` after reading (ADR 0006 R2).
- [ ] `npm run lint:arch`; spec Rulings filled; commit; `git-create-pr`, then `ci-green`. PR body:
  Left for Victor (release; `db:progress:recompute` lane 0 then prod; Android check; the spike
  lane `npm run lane:abandon -- spike_readiness_weakest`).
