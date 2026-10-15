# Phase 55 — A new word's intro stage, and help — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new word's first session opens with an intro stage (meet, read aloud, letter tiles — or typed when tiles cannot take the form) back to back, then three spaced practice cards; tiles and typed cards get help that grades as a miss, and a wrong typed answer is retyped.

**Architecture:** The card plan expands a ladder pick into an intro unit plus three practice cards and merges them as phase 54 did. The picker charges a ladder four slots, caps ladders at two and keeps a target's leftover slots from the main path. A `helped` flag on the text answer makes core `evaluate` record `wrong`; everything downstream already reads that verdict. The app checks tiles one by one, reveals typed letters on request, and runs the retype locally.

**Tech Stack:** TypeScript, Zod (wire contract in `packages/core`), Hono + Drizzle + Postgres (server), Expo / React Native (app), Jest, Playwright e2e, node:test (bots).

**Spec:** `docs/superpowers/specs/2026-10-16-lang-tutor-phase-55-new-word-intro-design.md` — read it first; D1–D9 are referenced by number below.

## Global Constraints

- Worktree: `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-55-new-word-intro`. Every command starts with `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-55-new-word-intro && …`. Never read, write or run anything in `/Users/victorprp/git/lang-tutor` outside this worktree. No `git -C`, no `git stash`.
- Read `docs/adr/` before touching `apps/server` or `apps/mobile`; `npm run lint:arch` must print no violation.
- Domain code is pure (ADR 0001): no clock, no IO in `apps/server/src/domain` or `packages/core/src/domain`.
- Wire types: `packages/core/src/api/types.ts` exports only `z.infer` types; `api/index.ts` only `export type` (ADR 0003).
- Constants: `LADDER_SLOTS = 4`, `NEW_PER_SESSION = 2`; `SESSION_LENGTH`, `NEW_FLOOR`, `DAY_NEW_CAP`, `RETURNS_PER_DAY` unchanged. `API_LEVEL` stays 4.
- UI copy is Hebrew, exactly: `help` **עזרה**, `tilesWrong` **לא האות הזאת**, `retypeNotice` **הקלידו את המילה שוב**, retry line uses the existing `tryAgain` **נסו שוב**, `feedbackHelped` **נכון, עם עזרה**; `meetSayAloud` is deleted.
- Comments follow the repo's style: `Phase 55 (spec Dn).` on new rules.
- Commits: conventional (`feat(server): …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Integration tests: `npm run test:integration` from the worktree root (lane DB). One file: `cd apps/server && bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath <file>`.
- Never run `expo lint` in `apps/mobile`. If an `npm install` is needed: `env -u npm_config_allow_scripts npm install`.
- `it.each` rows must have as many values as the callback has parameters (a short row makes Jest pass `done` and hang).
- A decision the spec does not cover: make the smallest reasonable one and report it in your final message as a line starting exactly `Ruling:` with what it costs if wrong.

## Review Focus

1. A word with a doubled letter, or an extra tile repeating a real letter (`mamma`, `caffè`): any tile with the right letter is right, and help picks an unused one — pinned in Task 6.
2. An accented word on the retype (`città` retyped `citta`): a near miss is not a right retype — pinned in Task 6.
3. A phrase or elision on the typed hint (`fare colazione`, `l'acqua`): a space or apostrophe is revealed with the letter after it — pinned in Task 6.
4. A stock prepared from picks chosen before the deploy (three ladders under the 3-slot cost): it prepares, as three new-shape ladders — pinned in Task 3.
5. A session reloaded in the middle of a retype: the first answer is on the server, so the session resumes at the next card with no retype state — pinned in Task 6.

---

### Task 1: `helped` in core and on the wire; tile letters move to core

**Files:**
- Modify: `packages/core/src/domain/quiz.ts` (`AnswerInput` text variant, `evaluate`), `packages/core/src/api/schemas.ts` (`NextStepRequestSchema` text shape, after `hint_opened`)
- Create: `packages/core/src/domain/tiles.ts` (`stripStress`, `tileLetters`), export from `packages/core/src/domain/index.ts`
- Modify: `apps/server/src/domain/tiles.ts` (use core's `tileLetters`), `apps/server/src/domain/languages.ts` (`stripStress` re-exported from core so its other callers keep working)
- Test: `packages/core/src/domain/quiz.test.ts`, `packages/core/src/domain/tiles.test.ts` (new), `apps/server/src/domain/tiles.test.ts` (unchanged, must pass)

**Interfaces:**
- Produces: `AnswerInput` text variant `{ text: string; helped?: boolean }`; wire `NextStepRequest` text shape `helped?: boolean` (comment: "Phase 55 (spec D6). Help used or a wrong tile placed on a letter_tiles or typed_translation card: graded wrong. Ignored on any other type."); `tileLetters(form: string): string[] | null` and `stripStress(text: string): string` from `@lang-tutor/core` domain (use the package's existing import path, as `judgeTiles` is imported today).

- [ ] **Step 1: Failing tests.** In `quiz.test.ts`, using the existing `typed` and `tiles` fixtures:

```ts
describe('phase 55: helped', () => {
  it('records a helped tiles or typed answer wrong, whatever its text', () => {
    expect(evaluate(tiles, { text: tiles.answer, helped: true })).toMatchObject({ is_correct: false, verdict: 'wrong', answer_string: tiles.answer });
    expect(evaluate(typed, { text: (typed as TypedTranslationQuestion).answer, helped: true })).toMatchObject({ is_correct: false, verdict: 'wrong' });
  });
  it('grades an unhelped answer as today', () => {
    expect(evaluate(tiles, { text: tiles.answer, helped: false }).verdict).toBe('exact');
    expect(evaluate(typed, { text: (typed as TypedTranslationQuestion).answer }).verdict).toBe('exact');
  });
  it('ignores helped on any other type', () => {
    expect(evaluate(dictation, { text: 'parlo', helped: true }).verdict).toBe('exact');
    expect(evaluate(CLOZE_TYPED, { text: (CLOZE_TYPED as ClozeTypedQuestion).answer, helped: true }).verdict).toBe('exact');
  });
  it('records a helped second try wrong', () => {
    expect(evaluateRetry(typed, { text: (typed as TypedTranslationQuestion).answer, helped: true }).verdict).toBe('wrong');
  });
});
```

  In the new `tiles.test.ts`: `tileLetters('casa')` → `['c','a','s','a']`; `tileLetters('Città')` → `['c','i','t','t','à']`; `tileLetters("l'acqua")`, `tileLetters('fare colazione')`, `tileLetters('ab')`, `tileLetters('appuntamento')` → `null`; `tileLetters('го́род')` → `['г','о','р','о','д']`.
- [ ] **Step 2:** `cd packages/core && npx jest src/domain` — the new tests fail.
- [ ] **Step 3: Implement.** In `evaluate`'s text branch: `const verdict = 'helped' in answer && answer.helped && HELPED.has(question.type) ? 'wrong' : verdictFor(question, answer.text);` with `const HELPED: ReadonlySet<QuestionType> = new Set(['letter_tiles', 'typed_translation']);` and a `Phase 55 (spec D6)` comment. `evaluateRetry` needs no change (it calls `evaluate`). Move `tileLetters` (and `stripStress`, its regex unchanged) into core's `tiles.ts`; the server's `tiles.ts` keeps `TILE_MIN_LETTERS`, `TILE_MAX_LETTERS`, `EXTRA_TILES`, `tileEligible`, `tilesFor` over core's `tileLetters` (export the two limits from core instead if `tileLetters` needs them, and re-export them from the server file). Add `helped: z.boolean().optional()` to the text shape of `NextStepRequestSchema`.
- [ ] **Step 4:** `cd packages/core && npx jest` and `cd apps/server && npx tsc --noEmit && npx jest src/domain/tiles.test.ts` pass.
- [ ] **Step 5: Commit** `feat(core): a helped tiles or typed answer is wrong; tile letters in core (phase 55)`.

### Task 2: The server records `helped`

**Files:**
- Create: `apps/server/src/db/migrations/0039_helped.sql` (+ journal/snapshot via the repo's drizzle generate script, as 0038 was made)
- Modify: `apps/server/src/db/schema.ts` (`answers.helped`, check `answers_helped_text`), `apps/server/src/repo/sessions.ts` (`insertAnswer` text shape gains `helped?: boolean | null`), `apps/server/src/routes/sessions.ts` (text body → `helped`), `apps/server/src/services/sessions.ts` (`answerText` input gains `helped?: boolean`; the answer passed to `submitAnswer` is `{ text, helped }` when defined; store it like `hinted`, for `letter_tiles` and `typed_translation` only)
- Test: `apps/server/tests/integration/routes/sessions.helped.test.ts` (new, modelled on `sessions.hint.test.ts`); `apps/server/tests/support/questions.ts` gains `readHelped` beside `readHintOpened`

**Interfaces:**
- Consumes: Task 1's `AnswerInput` `helped` and wire field.
- Produces: column `answers.helped boolean` (null unless a first text answer to tiles or typed carried it).

- [ ] **Step 1: Failing integration test.** In a session holding a `letter_tiles` and a `typed_translation` card (build it as `sessions.hint.test.ts` builds its cloze session): post `{ question_id, text: <answer>, helped: true }` to each → the stored rows have `verdict = 'wrong'`, `helped = true`, `typed_text = <answer>`; post the same text with `helped: false` in a second session → `verdict = 'exact'`, `helped = false`; with no `helped` → `helped is null`. Complete the first session and read its memory: the tiles gloss has written productive `lapses = 1` (Again), as a wrong tiles answer does. A `multiple_choice` answer never stores `helped`.
- [ ] **Step 2:** run that file — it fails.
- [ ] **Step 3: Implement.** Migration:

```sql
ALTER TABLE "answers" ADD COLUMN "helped" boolean;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_helped_text" CHECK ("answers"."helped" is null or "answers"."typed_text" is not null);
```

  In `submitAnswer`, beside `hinted`: `const helps = ['letter_tiles', 'typed_translation'].includes(type) ? { helped: 'helped' in answer ? answer.helped ?? null : null } : {};`. A retry stores nothing new in the column (the verdict is already `wrong` through `evaluateRetry`).
- [ ] **Step 4:** the file passes; `npm run test:integration` passes; `npx tsc --noEmit` in `apps/server`.
- [ ] **Step 5: Commit** `feat(server): store a helped answer as wrong, with helped (phase 55)`.

### Task 3: The card plan — the intro stage

**Files:**
- Modify: `apps/server/src/domain/plan.ts` (replace `LADDER_TYPES` with `ladderCards`; `Unit` gains `types?: QuestionType[]`; the stream; the output loop)
- Test: `apps/server/src/domain/plan.test.ts` (the phase 54 ladder tests at ~419–462 move to the new shape); `apps/server/tests/integration/services/` prepare-job test that phase 54 added for ladders (find it by `meet` in `tests/integration`)

**Interfaces:**
- Produces: `export function ladderCards(pick: Pick<PlanPick, 'tiles' | 'speakable'>, speaking: boolean): { intro: QuestionType[]; practice: QuestionType[] }` — intro `['meet', ...(speaking && pick.speakable ? ['read_aloud'] : []), pick.tiles ? 'letter_tiles' : 'typed_translation']`, practice `['multiple_choice', 'reverse_choice', 'typed_translation']`.

- [ ] **Step 1: Failing tests** in `plan.test.ts`:
  - `ladderCards` for `{tiles: true, speakable: true}` with speaking on → intro `meet, read_aloud, letter_tiles`; speaking off → `meet, letter_tiles`; `{tiles: false}` → `meet, read_aloud, typed_translation`; `{speakable: false}` → no `read_aloud`.
  - A session of **one** ladder pick and nothing else, speaking on: `types` = `meet, read_aloud, letter_tiles, multiple_choice, reverse_choice, typed_translation` (the `picks.length > 1` rule does not remove the ladder's read-aloud).
  - Two ladders, no other picks: `meet, read_aloud, letter_tiles, meet, read_aloud, letter_tiles, multiple_choice, multiple_choice, reverse_choice, reverse_choice, typed_translation, typed_translation`, `order` `0,0,0,1,1,1,0,1,0,1,0,1`.
  - One ladder and six other picks (and two ladders and two others): the intro cards are consecutive positions; no two other consecutive positions hold the same pick index; every intro card comes before the word's practice cards.
  - The session's speaking pick is still refused when `picks.length === 1` and it is the only pick (phase 25).
- [ ] **Step 2:** `cd apps/server && npx jest src/domain/plan.test.ts` — fails.
- [ ] **Step 3: Implement.** The stream:

```ts
// Phase 55 (spec D3). A word's intro stage is one unit, so nothing is merged inside it;
// then every ladder's first practice card, its second, its third, each stage in pick order.
const ladders = picks.flatMap((pick, index) => (pick.ladder ? [index] : []));
const cardsOf = ladders.map((index) => ladderCards(picks[index], input.speaking));
const intro: Unit[] = ladders.map((index, k) => ({ indices: cardsOf[k].intro.map(() => index), type: 'meet', types: cardsOf[k].intro, p: 1, step: false }));
const practice: Unit[] = [0, 1, 2].flatMap((stage) => ladders.map((index, k) => ({ indices: [index], type: cardsOf[k].practice[stage], p: 1, step: false })));
const stream = [...intro, ...practice];
```

  and in the output loop `types.push(unit.types?.[k] ?? unit.type)` for the k-th index. The merge is unchanged (it already compares `stream[a].indices[0]`).
- [ ] **Step 4: Prepare job (integration).** Extend the phase 54 prepare-job ladder test: a ladder pick on a tile form with `speaking: true` writes `meet, read_aloud, letter_tiles, multiple_choice, reverse_choice, typed_translation` for its gloss (the tiles row has 5–12 tiles); a non-tile form (`fare colazione` or an 11+ letter word) writes `typed_translation` in place of tiles; a payload with **three** ladder picks (a stock chosen before the deploy) prepares, with all three ladders' cards. Run it.
- [ ] **Step 5:** `npx jest src/domain` and the integration file pass. **Commit** `feat(server): a ladder opens with an intro stage (phase 55)`.

### Task 4: The picker — four slots, two ladders, a target's leftovers

**Files:**
- Modify: `apps/server/src/domain/chooseConstants.ts` (`LADDER_SLOTS = 4`, `NEW_PER_SESSION = 2`, comments), `apps/server/src/domain/choose.ts` (`choosePools`' passes, ~490–505)
- Test: `apps/server/src/domain/choose.test.ts` ("ladders" describe ~599–736 and the constants at ~225–261, 487–489, 580), `apps/server/src/domain/targetSession.test.ts` (151–160, 225–229, 266–270, 373, 390–405, 463–468), `apps/server/tests/integration/services/sessions.test.ts:160`, `apps/server/tests/integration/services/sessionsChoose.test.ts:121`

**Interfaces:**
- Consumes: nothing new. Produces: the D4/D5 behaviour; `choosePools`' signature is unchanged.

- [ ] **Step 1: Failing tests.**
  - `choose.test.ts`: a ladder costs four slots; a list of only new words gives two ladders and no third; a backlog of due words gives one ladder and six reviews; a run with three slots free adds no ladder.
  - `targetSession.test.ts`: a fresh 30-word homework target (wish 10) gives exactly two ladders and **no main-path pick** although the main path has words (replaces the test at 151–160 that expected `NEW_PER_SESSION + 1`); two targets: the first target's unused slots reach the second; an empty target (no words) still passes its slots to the main path; a main path with fewer words than its share passes its own unused slots back to a target; the exam's eve (exclusive) with a small exam shows no main-path pick.
- [ ] **Step 2:** `cd apps/server && npx jest src/domain/choose.test.ts src/domain/targetSession.test.ts` — fail.
- [ ] **Step 3: Implement.** Keep two counters in `choosePools`: `unused`, slots any pool may take (the main path's own leftovers, and an empty target's — `pool.glossIds?.size === 0`), and `targetsOnly`, a target's leftovers. First pass: a target runs with `pool.slots + unused + targetsOnly`, and what it leaves goes to `targetsOnly` (or to `unused` when the target is empty); the main path runs with `pool.slots + unused` and what it leaves is `unused`. Later passes: a target is offered `targetsOnly + unused`, consuming `targetsOnly` first; the main path is offered `unused` only. The ruling-15 pass (`taken.size === 0`) offers both to every pool, as today. Comment it `Phase 55 (spec D5)`, amending the phase 53 R7 / phase 54 comments there.
- [ ] **Step 4:** unit tests pass; update the two integration tests' arithmetic to the new constants and run `npm run test:integration`.
- [ ] **Step 5: Commit** `feat(server): a ladder costs four slots, two a session, and a target's leftovers stay off the main path (phase 55)`.

### Task 5: The day simulation proves it

**Files:**
- Modify: `apps/server/src/domain/day.test.ts` (outcomes 8–11 `itHoldsTheLadders` ~314–414, `slotsOf` 136, `expectNewWordsEachSession` 285–310, the new-learner run 515–536, families 616–666, `READY_ON_DUE_PASS` 679–690, `unfilled` 830–838, exam/target runs 999–1223)

- [ ] **Step 1:** Set the literal ladder to `['meet', 'read_aloud', 'letter_tiles', 'multiple_choice', 'reverse_choice', 'typed_translation']` (the sim plans with `tiles: true, speakable: true, speaking: true`; keep it a literal, not imported). Outcome 8: a ladder word's first cards of the day are the intro unit back to back, then the three practice cards in order. Outcome 9: ladders ≤ `NEW_PER_SESSION`; cards other than `meet` and a ladder's `read_aloud` ≤ `SESSION_LENGTH`. Outcome 10: the adjacency bound counts adjacent same-word pairs outside a word's intro unit. Target runs: no main-path pick in a session where a target left slots unused (D5); `unfilled` and the exam-alone checks move to four slots and two ladders.
- [ ] **Step 2:** `cd apps/server && npx jest src/domain/day.test.ts`. Where a phase 53/54 measure moves (ready-on-due, the families aggregate, the new learner's words met per day), re-measure it on the five phases and compare with master's five-phase figure (run the same measure on `origin/master` in a scratch copy of the test if needed). Never lower a mark: a real drop is reported as `Ruling:` with both figures, and the mark is restated only for a reason the spec gives (two ladders a session meets fewer words; D5 gives targets shorter sessions).
- [ ] **Step 3: Commit** `test(server): the day simulation holds the intro stage and the cap of two (phase 55)`.

### Task 6: The app — tiles, typed help, the retype, the meet card

**Files:**
- Modify: `apps/mobile/src/tiles.ts` (+ `tiles.test.ts`), `apps/mobile/src/components/LetterTilesView.tsx`, `apps/mobile/src/components/TypedAnswerView.tsx`, `apps/mobile/src/components/MeetCardView.tsx` (delete the `meet-say` line and its doc mention), `apps/mobile/src/app/session.tsx` (props for help/retype; banner gating), `apps/mobile/src/hooks/useSession.tsx`, `apps/mobile/src/quiz.ts` (+ `quiz.test.ts`), `apps/mobile/src/feedback.ts` (+ `feedback.test.ts`), `apps/mobile/src/strings.ts` (+ `strings.test.ts`)
- Create: `apps/mobile/src/typedHelp.ts` (+ test), `apps/mobile/src/retype.ts` (+ test)

**Interfaces:**
- Consumes: core `tileLetters`, `judgeTyped`, `evaluate`; `AnswerInput` `{ text, helped }`; wire `helped`.
- Produces (pure, unit-tested):
  - `tiles.ts`: `tryTile(placed: readonly number[], tile: number, tiles: readonly string[], expected: readonly string[]): { placed: number[]; wrong: boolean }`; `helpTile(placed, tiles, expected): number | null` (the first unused tile whose letter is `expected[placed.length]`); `isBuilt(placed, expected): boolean`. `expected = tileLetters(question.answer) ?? []`.
  - `typedHelp.ts`: `revealed(answer: string, presses: number): string` — `presses` letters from the start, a space or apostrophe always taken with the letter after it; `allRevealed(answer, presses): boolean`.
  - `retype.ts`: `type Retype = { attempt: 1 | 2; showing: boolean; outcome: 'right' | 'failed' | null }`; `opensRetype(question: Question, text: string): boolean` (`typed_translation` whose text verdict — `evaluate(question, { text }).verdict`, without `helped` — is `wrong` or `near_miss`); `startRetype(): Retype`; `retypeTyping(r): Retype` (hides the answer); `retypeChecked(r, question, text): Retype` (`judgeTyped` `exact` → `right`; else attempt 1 → attempt 2 showing; attempt 2 → `failed`).

- [ ] **Step 1: Failing unit tests.**
  - `tiles.test.ts`: for `mamma` with tiles `['m','a','m','m','a','x','m']`, tapping any `m` first is right; a wrong tile returns `wrong: true` and leaves `placed` unchanged; `helpTile` skips placed tiles; `isBuilt` after the last letter. For `caffè`, the `è` tile is right and an `e` tile is wrong.
  - `typedHelp.test.ts`: `revealed('colazione', 3)` = `'col'`; `revealed('fare colazione', 5)` = `'fare c'`; `revealed("l'acqua", 1)` = `'l'`, `revealed("l'acqua", 2)` = `"l'a"`; `allRevealed('casa', 4)` true.
  - `retype.test.ts`: opens on wrong, near miss (`citta` for `città`) and `''`; not on exact, not on another accepted word, not on letter tiles; `città` retyped `citta` is not right (attempt 2); right on the second attempt; failed after two wrong; typing hides the answer.
  - `quiz.test.ts`: `nextStepRequest` puts `helped` in the body of a tiles/typed text answer, first try and second try, and omits it when undefined; `enter` (a session loaded mid-retype) starts with no retype.
  - `feedback.test.ts`: a helped right tiles or typed answer gives tone `other`, title `נכון, עם עזרה`, no line; a retype ended right gives `נכון!`; failed gives `התשובה הנכונה:` and the answer.
  - `strings.test.ts`: the new strings; `meetSayAloud` gone.
- [ ] **Step 2:** `cd apps/mobile && npx jest` — the new tests fail.
- [ ] **Step 3: Implement the pure modules**, then the views:
  - `LetterTilesView`: tap → `tryTile`; a wrong tap shows `tiles-wrong` (**לא האות הזאת**) until the next right tile and sets helped; **עזרה** `tiles-help` → `helpTile`, sets helped; placed slots are not removable; when `isBuilt`, call `onSubmit(builtWord(tiles, placed), helped)` once; remove `tiles-submit`; keep `tiles-show-answer` (`onSubmit('', helped)`).
  - `TypedAnswerView`: **עזרה** `typed-help` increments presses (disabled when `allRevealed`); `typed-hint` shows `revealed(...) + '…'` LTR apart from the input; submit sends `onSubmit(text, presses > 0)`. In retype mode (prop `retype: Retype | null`): show the first answer's title, `retype-answer` while `showing`, `retype-notice` (**הקלידו את המילה שוב**, or **נסו שוב** on attempt 2), an empty editable input whose first character calls `onRetypeTyping`, and **בדיקה** calling `onRetype(text)`; no show-answer and no skip during the retype.
  - Hook: `submitText(text, { hintOpened?, helped? })` (update the cloze call site); the input sent is `{ text, helped }`; after a first typed answer where `opensRetype`, set `retype: startRetype()` and speak the word as the banner cue does; `hasBanner` is false and `next()` is ignored while `retype && retype.outcome === null`; `retypeTyping`/`retypeChecked` actions; `enter` and the next card reset `retype` to null. The server request is sent as today and its response queued.
  - `feedback.ts`: compute the text verdict without `helped`; a helped answer whose text verdict is `exact` or `alternative` → `{ tone: 'other', title: strings.feedbackHelped, line: null }`; a retype outcome overrides the banner (`right` → `feedbackCorrect`, no line; `failed` → `feedbackWrong` + `rightAnswer`).
  - `MeetCardView`: delete the `meet-say` `Text` and `strings.meetSayAloud`.
- [ ] **Step 4:** `cd apps/mobile && npx jest && npx tsc --noEmit` pass.
- [ ] **Step 5: Commit** `feat(mobile): tiles checked as placed, help on tiles and typed, the retype (phase 55)`.

### Task 7: The bots

**Files:**
- Modify: `bots/src/analysis.ts` (~110–146), `bots/src/report.ts` (~190–218), `bots/src/fakeServer.ts` (a `tilesCard` helper), `bots/src/answer.test.ts`, `bots/src/play.test.ts`

- [ ] **Step 1: Failing tests.** `answer.test.ts`: a `letter_tiles` card the bot knows is answered `{kind: 'text'}` with `card.answer`, and it never sends `helped`. `play.test.ts`: a session with a ladder of the new shape (meet, read aloud, tiles, multiple choice, reverse choice, typed) plays through: meet `seen`, read aloud spoken, tiles and typed as text, the meet card out of `line.cards`. Analysis/report: the intro read-aloud and tiles of a laddered word count as ladder cards — not "the same word again", not off-rung in metric (d).
- [ ] **Step 2:** `cd bots && node --test src/*.test.ts` — the new tests fail; implement; pass.
- [ ] **Step 3: Commit** `feat(bots): the bots play the intro stage (phase 55)`.

### Task 8: e2e

**Files:**
- Modify: `e2e/tests/meet.spec.ts` (no `meet-say` at ~69; the ladder after the meet card is tiles (and read aloud only if the e2e session can speak) then MC, reverse, typed; new totals and scores), `e2e/tests/support/cards.ts` (`kindOnScreen` unchanged order; a `buildTiles(page)` helper that taps the right tiles and waits for the card to answer itself, replacing `tiles-submit` clicks), `e2e/tests/listening-variety.spec.ts` (its `buildFromTiles` uses the new helper), and every spec whose ladder card totals are hard-coded: `progress.spec.ts`, `speaking.spec.ts`, `answer-language.spec.ts`, `sentence-cards.spec.ts`, `next-session.spec.ts`, `glosses.spec.ts`, `meaning-recall.spec.ts`
- Create: `e2e/tests/help.spec.ts`

- [ ] **Step 1: Write `help.spec.ts`** on a one-ladder session (as `meet.spec.ts` builds one): after **המשך**, on the tiles card tap a wrong tile → `tiles-wrong` visible and `tiles-built` unchanged; tap **עזרה** → the next letter is placed; finish with the right tiles → banner tone `other` with **נכון, עם עזרה**, and the request body for that card has `helped: true`. On the ladder's typed card: tap `typed-help` twice → `typed-hint` shows the first two letters and `…`; submit a wrong word → `retype-answer` shows the right answer and `retype-notice`; type one character → `retype-answer` hidden; submit a wrong retype → the answer shows again with **נסו שוב**; submit the right word → banner **נכון!**, `continue-button`. The body for that card has `helped: true` and the session's score counts both cards wrong.
- [ ] **Step 2:** Update `meet.spec.ts` and the specs listed above to the new ladder and totals; run `npm run e2e` (lane-derived ports) until green. If `next-session.spec` "past the seed" or the Chromium install flakes, rerun once (known flakes); anything else is a real failure.
- [ ] **Step 3: Commit** `test(e2e): the intro stage, help and the retype (phase 55)`.

---

## Finishing

After Task 8 and the final review: the spec's **Rulings** gets every `Ruling:` line from the task reports (grep the reports broadly for `Ruling`), committed as `docs(spec): phase 55 records the rulings of its run`; then `git-create-pr` and `ci-green` (CLAUDE.md, *Finishing a branch*). Left for Victor: the release, testing on his Android phone, and the §3 count against production.
