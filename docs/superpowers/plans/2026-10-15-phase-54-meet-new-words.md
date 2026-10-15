# Phase 54 — Meet a new word Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new (or never-right) word's first session is a ladder — an ungraded meet card, then multiple choice, reverse choice and typed translation spread through the session — and a session holds at most three ladders.

**Architecture:** The picker (`choose.ts`) classes unlearned glosses `NEW`, flags them `ladder`, charges a ladder three slots and caps ladders at three a session. The card plan (`plan.ts`) expands a ladder pick into four positions and merges them evenly among the other cards. A new `meet` question type and a `seen` answer carry it over the wire, through storage, to a new app card view; the bots and the day simulation learn it.

**Tech Stack:** TypeScript, Zod (wire contract in `packages/core`), Hono + Drizzle + Postgres (server), Expo / React Native (app), Jest, Playwright e2e, node:test (bots).

**Spec:** `docs/superpowers/specs/2026-10-15-lang-tutor-phase-54-meet-new-words-design.md` — read it first; D1–D8 are referenced by number below.

## Global Constraints

- Worktree: `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-54-meet-new-words`. Every command starts with `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-54-meet-new-words && …`. Never read, write or run anything in `/Users/victorprp/git/lang-tutor` outside `.claude/worktrees/phase-54-meet-new-words`.
- Read `docs/adr/` before touching `apps/server` or `apps/mobile`; `npm run lint:arch` must print no violation.
- Domain code is pure (ADR 0001): no clock, no IO in `apps/server/src/domain` or `packages/core/src/domain`.
- Wire types: `packages/core/src/api/types.ts` exports only `z.infer` types; `api/index.ts` only `export type` (ADR 0003).
- UI copy is Hebrew, plural imperative: title **מילה חדשה**, prompt **אמרו את המילה בקול**, button **המשך**.
- Constants: `LADDER_SLOTS = 3` (new); `NEW_PER_SESSION = 3` (now also the ceiling); `SESSION_LENGTH`, `DAY_NEW_CAP`, `NEW_FLOOR`, `RETURNS_PER_DAY` unchanged. `API_LEVEL` 3 → 4.
- Ladder order is fixed: `meet`, `multiple_choice`, `reverse_choice`, `typed_translation`.
- Comments follow the repo's style: `Phase 54 (spec Dn).` on new rules.
- Commits: conventional (`feat(server): …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`.
- Integration tests: `npm run test:integration` from the worktree root (lane DB). To run one file: `cd apps/server && bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath <file>`.

## Review Focus

1. A learner whose list is all brand-new words (a fresh target of 30): sessions must hold three ladders, never four, and still be a session (not empty) — pinned in Task 2 and Task 5.
2. A word answered wrong on every ladder card: next session it must come back as a ladder (meet again), not a cold recall card, and stop after `RETURNS_PER_DAY` — pinned in Task 2 and Task 5.
3. A stock prepared before the deploy (picks without `ladder`): it must prepare exactly as before — pinned in Task 4.
4. A ladder whose practice cards are all refused by validation or the checker: no lone meet card — pinned in Task 4.
5. A session with one ladder and only one or two other cards: no two cards of the word adjacent while another card can go between — pinned in Task 3.

---

### Task 1: The `meet` card and `seen` answer in the wire contract and core domain

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (MeetQuestionSchema, QuestionSchema union, AnswerVerdictSchema, NextStepRequestSchema), `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Modify: `packages/core/src/domain/quiz.ts`, `packages/core/src/domain/memoryGrades.ts`, `packages/core/src/apiLevel.ts`
- Modify (exhaustive switches the compiler names): `apps/server/src/domain/progress.ts` (`evidenceFor`), `apps/server/src/domain/plan.ts` (`eligible`: `case 'meet': return false`), `apps/server/src/domain/distractors.ts` (`taskFor`: meet asks nothing), `apps/server/src/repo/progress.ts` (`TEXT_TYPES` gains `meet`), and any other server switch `npx tsc --noEmit` in `apps/server` reports.
- Test: `packages/core/src/domain/quiz.test.ts`, `packages/core/src/domain/memoryGrades.test.ts`, the server tests of the files above.

**Interfaces:**
- Produces: `MeetQuestion` type (`{ id; type: 'meet'; vocab_term_id; question: string /* form */; meaning: string /* Hebrew */ }`); `AnswerInput` gains `{ seen: true }`; `NextStepRequest` gains `{ question_id: string; seen: true }`; `AnswerVerdict` gains `'seen'`; `API_LEVEL = 4`.

- [ ] **Step 1: Failing core tests.** In `quiz.test.ts`: `answerFits(meet, { seen: true })` true and false for `{ option_index: 0 }`, `{ text: 'x' }`, `{ pass: 'skip' }`; `answerFits(readAloud, { seen: true })` false; `evaluate(meet, { seen: true })` gives `{ is_correct: false, answer_string: '', verdict: 'seen', retry_state: null, … }`; `verdictCorrect('seen')` false; `score([meet, mc], [seenRecord, rightRecord])` is `{ correct: 1, total: 1 }`; `missed` omits the meet card; `rightAnswer(meet)` is its form; `isChoice(meet)` false. In `memoryGrades.test.ts`: `gradesFor({ type: 'meet', verdict: 'seen' })` and `dimensionsTested('meet')` are `[]`.
- [ ] **Step 2:** `cd packages/core && npx jest src/domain` — the new tests fail.
- [ ] **Step 3: Implement.** Schema, after `ReadAloudQuestionSchema`:

```ts
// Phase 54 (spec D1, D6). A new word, shown before it is asked: its form, spoken,
// and its meaning. Ungraded: answered with `seen`.
export const MeetQuestionSchema = z.object({
  id: z.string(),
  type: z.literal('meet'),
  vocab_term_id: z.string(),
  question: z.string(),
  meaning: z.string(),
});
```

  Add it to `QuestionSchema`; add `'seen'` to `AnswerVerdictSchema`; add `z.object({ question_id: z.string().min(1), seen: z.literal(true) })` as the fourth `NextStepRequestSchema` member with a `// Phase 54 (spec D6)` comment. In `quiz.ts`: `AnswerInput` gains `| { seen: true }`; `answerFits` returns `'seen' in answer` for a meet card first and refuses `seen` on every other type; `evaluate` handles `question.type === 'meet' && 'seen' in answer` → `recorded(question, { question_id, is_correct: false, answer_string: '', verdict: 'seen' })`; `verdictCorrect` false for `seen`; `score` leaves out records with verdict `skipped` **or** `seen`; `missed` filters `seen` too; `isChoice`/`rightAnswer` learn `meet` (`rightAnswer` → `question.question`). `gradesFor`/`dimensionsTested`: `case 'meet': return []`. `apiLevel.ts`: `API_LEVEL = 4` with a `4: phase 54 (spec D6). The meet question type and the seen answer: an older app cannot draw the card.` line.
- [ ] **Step 4:** Make `npx tsc --noEmit` pass in `packages/core` and `apps/server` (the switches listed above; `evidenceFor` gives a meet card no evidence). `apps/mobile` and `bots` typecheck stay red until Tasks 6 and 7 — expected.
- [ ] **Step 5:** `cd packages/core && npx jest` and `cd apps/server && npx jest --selectProjects unit` pass. Also update the next-step route's prose in `apps/server/src/routes/sessions.ts` (~line 197) to list `seen` for a meet card.
- [ ] **Step 6:** Commit `feat(core): the meet card and the seen answer (phase 54, spec D1, D6)`.

---

### Task 2: The picker — unlearned words, ladder flag, slots and ceiling

**Files:**
- Modify: `apps/server/src/domain/choose.ts`, `apps/server/src/domain/chooseConstants.ts`
- Modify (callers of `ChoiceInput.families`): `apps/server/src/services/sessions.ts` (`readChoice`: pass `introductions: new Set(families.introductions.keys())`), `apps/server/src/domain/day.test.ts`, `choose.test.ts`, `targetSession.test.ts` (add `introductions` to their inputs)
- Test: `apps/server/src/domain/choose.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ChoiceInput.families.introductions: ReadonlySet<string>`; `ChosenPick.ladder: boolean`; `LADDER_SLOTS` exported from `chooseConstants.ts`; `choosePools`/`chooseWords`/`chooseWithTargets` signatures unchanged.

- [ ] **Step 1: Failing tests** in `choose.test.ts` (one `it` each, built with the file's existing input helpers):
  1. A gloss with no memory is `NEW` with `ladder: true`; with memory rows all `reps === lapses` it is `NEW` and `ladder: true`; with any row `reps > lapses` it is not `NEW`.
  2. A gloss in `families.introductions` with no memory is `NEW` with `ladder: false` and takes one slot.
  3. An unlearned gloss with a step owed today is `NEW`, not `STEP`; an unlearned gloss in `done` (no step) is `DONE`.
  4. Thirty saved glosses, none met: the session has exactly three ladder picks and its picks' slots (`ladder ? 3 : 1`) sum to at most `SESSION_LENGTH` (three ladders + at most one other pick).
  5. A backlog of ten due words and five new words: one ladder (`NEW_FLOOR`) and seven due words.
  6. Two pools (a target with 10 unmet words and slots 6; the main path with 10 unmet words): at most three ladders across both, and no pool's picks pass its offered slots.
  7. A run with two free slots and only new words left adds no ladder (the session ends short).
  8. Ruling 15 (empty session past the daily cap, `newToday: DAY_NEW_CAP`): at most three ladders.
- [ ] **Step 2:** `cd apps/server && npx jest src/domain/choose.test.ts` — the new tests fail.
- [ ] **Step 3: Implement** (spec D2, D4):
  - `chooseConstants.ts`: `export const LADDER_SLOTS = 3;` documented as "Phase 54 (spec D4). Slots of SESSION_LENGTH a new word's first session takes: its three practice cards; the meet card is free." Re-document `NEW_PER_SESSION` as also the most ladders a session holds.
  - `ChosenPick` gains `ladder: boolean`; `pickOf` sets `ladder: cls === 'NEW' && !input.families.introductions.has(glossId)` (a `SPEAK` pick is never a ladder).
  - Classification: compute `learned = new Set(input.memory.filter((row) => row.state.reps > row.state.lapses).map((row) => row.glossId))`; the class order becomes `if (!learned.has(glossId)) NEW (written_receptive) else if (owed) STEP else …as today…`, and keep `if (!owed && (done || waiting)) cls = 'DONE'` after it, so an unlearned gloss done today is `DONE` and one owed a return stays `NEW`.
  - In `run`: replace the single `n` with two bounds and count slots:

```ts
const cost = (pick: ChosenPick) => (pick.ladder ? LADDER_SLOTS : 1);
const pickCap = Math.min(groups, groupsAtFirst[index] - chosen[index].length);
let used = 0;
const fits = (candidate: Candidate) => used + cost(candidate.pick) <= slots && picks.length < pickCap;
const full = () => used >= slots || picks.length >= pickCap;
const speak = input.speaking && Math.min(slots, pickCap) >= 2 ? Math.max(0, SPEAKING_PER_SESSION - spoken) : 0;
const room = slots - speak - returns.length - due.length;
const ladderRoom = (free: number) => Math.floor(Math.max(0, free) / LADDER_SLOTS);
const reserve = Math.min(
  fresh.length,
  newLeft,
  NEW_PER_SESSION - ladders,
  Math.max(Math.min(NEW_PER_SESSION, Math.max(NEW_FLOOR, ladderRoom(room))), Math.min(owedLeft, ladderRoom(slots))),
);
```

    `ladders` is a session-wide counter beside `newCount`. `add` does `used += cost(candidate.pick)` and `if (candidate.pick.ladder) ladders++`. `offer` and `fill` stop on `full()` and skip a candidate that does not `fits`. `offerFresh(limit)` skips (and moves past) a candidate that is not `free`, does not `fits`, or is a ladder while `ladders >= NEW_PER_SESSION`. The speaking loop's `picks.length < n` becomes `!full()`. `run` returns `used`. Update the doc comments that say "picks" where they now mean slots.
- [ ] **Step 4:** `cd apps/server && npx jest src/domain` — the new tests pass. Existing `choose.test.ts`, `targetSession.test.ts` and `day.test.ts` expectations that change because new words now cost three slots: update each to the new rule and list every changed expectation, with its reason, in the commit message body (`Ruling:` lines). Do not weaken an assertion to make it pass: a changed number must follow from D4.
- [ ] **Step 5:** `cd apps/server && npx tsc --noEmit && npx jest --selectProjects unit`.
- [ ] **Step 6:** Commit `feat(server): a new word takes three slots, three a session at most (phase 54, spec D2, D4)`.

---

### Task 3: The card plan — a ladder's four cards, merged evenly

**Files:**
- Modify: `apps/server/src/domain/plan.ts`
- Test: `apps/server/src/domain/plan.test.ts`

**Interfaces:**
- Consumes: `QuestionType` includes `'meet'` (Task 1).
- Produces: `PlanPick.ladder?: boolean` (absent = false); `LADDER_TYPES: readonly QuestionType[] = ['meet', 'multiple_choice', 'reverse_choice', 'typed_translation']` exported; `planCards` returns `SessionPlan` as today, `order` listing a ladder pick's index four times.

- [ ] **Step 1: Failing tests** in `plan.test.ts`:
  1. One ladder pick among six others: its four positions carry `LADDER_TYPES` in order; the other six picks get the types they get today.
  2. Ladder cards do not count toward `MAX_PER_TYPE` (five non-ladder reverse-choice-eligible picks still get their usual types beside two ladders), and a ladder's `multiple_choice` is never on a board.
  3. Three ladders, no other cards: order is M_A M_B M_C A1 B1 C1 A2 B2 C2 A3 B3 C3 (by pick index).
  4. Three ladders and one other card; two ladders and four others; one ladder and two others: no two adjacent positions share a pick index; every ladder's cards are in `LADDER_TYPES` order.
  5. One ladder and nothing else: four positions in a row (`[0,0,0,0]`).
  6. Returns (`step: true`) are after every ladder card.
  7. A pick without `ladder` plans exactly as today (an existing test fixture, unchanged output).
- [ ] **Step 2:** `cd apps/server && npx jest src/domain/plan.test.ts` — the new tests fail.
- [ ] **Step 3: Implement** (spec D3, D5). In `planCards`: compute `cards` for non-ladder picks only (a ladder pick has no `cardFor` and touches no `used` count); the board considers non-ladder multiple-choice picks only. Build `first = ordered(nonStepUnits, null)` as today, then:

```ts
// Phase 54 (spec D5). The ladder stream, stage by stage: every meet card, then every
// first practice card, and so on, each stage in pick order.
const ladders = picks.flatMap((pick, index) => (pick.ladder ? [index] : []));
const stream: Unit[] = LADDER_TYPES.flatMap((type) => ladders.map((index) => ({ indices: [index], type, p: 1, step: false })));
// Merged evenly with the other cards; a ladder card never follows its own word while
// another card is left to put between them.
const merged: Unit[] = [];
let a = 0;
let b = 0;
while (a < stream.length || b < first.out.length) {
  const L = stream.length;
  const O = first.out.length;
  let fromStream = b >= O || (a < L && (a + 0.5) / L <= (b + 0.5) / O);
  const last = merged[merged.length - 1];
  if (fromStream && b < O && last && last.indices.includes(stream[a].indices[0])) fromStream = false;
  merged.push(fromStream ? stream[a++] : first.out[b++]);
}
const returns = ordered(units.filter((unit) => unit.step), merged.at(-1)?.type ?? null);
```

  and lay out `[...merged, ...returns.out]` exactly as the loop does today. `cardFor`/`eligible` never return `meet`.
- [ ] **Step 4:** `cd apps/server && npx jest src/domain/plan.test.ts` passes; `npx jest --selectProjects unit` passes.
- [ ] **Step 5:** Commit `feat(server): a ladder's four cards, spread through the session (phase 54, spec D3, D5)`.

---

### Task 4: Storage and the prepare job

**Files:**
- Create: a migration via `cd apps/server && bash ../../scripts/lane-env.sh npx drizzle-kit generate --name meet_cards` after editing `schema.ts`
- Modify: `apps/server/src/db/schema.ts` (`questions_type_known`, `questions_shape_valid` with `when 'meet' then options is null and prompt is not null and alternatives is null and tiles is null`, `answers_verdict_known` gains `'seen'`; `answers_retry_verdict_known` is unchanged, since a meet card has no retry)
- Modify: `apps/server/src/services/sessions.ts` (`choosePicks`: stored pick gains `ladder`; the prepare job: `PlanPick.ladder` from the payload, meet cards built with no model content, lone meet cards dropped), the `PREPARE_SESSION` payload schema wherever it is validated (`domain/jobs.ts` — `ladder: z.boolean().optional()`), `apps/server/src/repo/questions.ts` (`questionFrom` and the insert build a meet card: `prompt` = the rendering's translation, wire `question` = form, `meaning` = prompt), `apps/server/src/repo/sessions.ts` (`insertAnswer` stores `seen` as text `''` + verdict `seen`), `apps/server/src/domain/keepCards.ts` (a helper, below)
- Test: `apps/server/src/domain/keepCards.test.ts`, `apps/server/src/services/sessions.prepare.test.ts` (integration), `apps/server/src/services/sessions.test.ts` (integration: answering a meet card)

**Interfaces:**
- Consumes: Task 1 types, Task 2 `ChosenPick.ladder`, Task 3 `PlanPick.ladder` and `LADDER_TYPES`.
- Produces: `dropLoneMeets(fates: CardFate[], glossOf: (index: number) => string, typeOf: (index: number) => QuestionType): CardFate[]` in `keepCards.ts` — every `meet` position whose gloss has no other kept (`keep` or `keep_refused`) position becomes `{ fate: 'drop', refusal: { stage: 'validation', reason: 'no practice card left for its meet card' } }`.

- [ ] **Step 1: Failing tests.** Unit (`keepCards.test.ts`): `dropLoneMeets` drops a meet whose three practice positions are dropped, keeps it when one practice card is kept or kept refused, never touches non-meet fates. Integration (`sessions.prepare.test.ts`, following that file's existing MockServer stubs): a stock whose picks include one `ladder: true` pick prepares a session whose positions for that gloss are `meet`, `multiple_choice`, `reverse_choice`, `typed_translation`, the meet card's question is the form and meaning the translation; a pick with no `ladder` field prepares as today; a ladder whose three practice cards the validation refuses keeps no meet card (fill the distractor stub with unusable options for that gloss). Integration (`sessions.test.ts`): answering a meet card with `{ seen: true }` stores verdict `seen`, the next step comes back with no `pending_retry`, the completed session's `score.total` leaves it out, the gloss's memory is untouched by it, and `findIntroducedOn` lists the gloss for the day.
- [ ] **Step 2:** Run those files (Global Constraints' one-file command) — the new tests fail.
- [ ] **Step 3: Implement.** Schema checks and the generated migration (one `.sql` plus its snapshot; check the SQL only drops and re-adds the three constraints). `choosePicks` writes `ladder: choice.ladder` into each stored pick. The prepare job passes `ladder: read.picked[index].ladder ?? false` into each `PlanPick`; `tasksFor` already gives a meet position no task (Task 1); the card-writing path builds a meet card from its row (form, translation) with no distractors, context or checker item; after `keepCards`, apply `dropLoneMeets`. Any per-position code that assumed one position per gloss and breaks on the repeats gets fixed here (the integration test will show it).
- [ ] **Step 4:** `npm run test:integration` passes from the worktree root; `cd apps/server && npx jest --selectProjects unit && npx tsc --noEmit`.
- [ ] **Step 5:** Commit `feat(server): meet cards stored, prepared and answered (phase 54, spec D7)`.

---

### Task 5: The day simulation proves the ladder

**Files:**
- Modify: `apps/server/src/domain/day.test.ts` (and `day.fixture.ts` only if needed)

**Interfaces:**
- Consumes: Tasks 1–3 (`planCards` with `ladder`, `meet` type, `gradesFor('meet') = []`).

- [ ] **Step 1:** The runner passes `ladder: pick.ladder` into each `PlanPick`; `answerOf` answers a meet card `seen` (no grade); the `Asked` record keeps every position (meet included) with its gloss and type.
- [ ] **Step 2: New outcomes**, added to every run (lane 0's day, the thirty-new-words learner, the families runs, every phase 53 target scenario):
  8. Every pick with `ladder: true` is asked as meet, multiple choice, reverse choice, typed translation, in that order, in its session.
  9. No session holds more than three ladders; no session's graded cards exceed `SESSION_LENGTH`.
  10. In a session with a ladder and at least one other card, no two adjacent cards share a gloss.
  11. A word whose ladder ended with every practice card wrong is laddered again in a later session that day while its returns last (use the existing scripted learner's wrong answers; if none occur, add a run whose learner misses one word's ladder).
  And for the thirty-new-words learner: it meets all thirty words, at most three a session.
- [ ] **Step 3:** Run `cd apps/server && npx jest src/domain/day.test.ts`. Phase 53's outcomes must still hold. Its ready-on-due measures (`READY_ON_DUE_PASS`) are re-measured: report the before and after numbers in the commit body; if one drops below its pass mark, stop and report it to the controller instead of changing the mark.
- [ ] **Step 4:** Commit `test(server): the day simulation proves a new word's ladder (phase 54)`.

---

### Task 6: The app's meet card, and e2e

**Files:**
- Create: `apps/mobile/src/components/MeetCardView.tsx`
- Modify: `apps/mobile/src/app/session.tsx` (`renderQuestion` case), `apps/mobile/src/hooks/useSession.tsx` (a `seen()` action modelled on `pass('skip')`: `advanceRequested: true`, no banner), `apps/mobile/src/cardVoice.ts` (`meet`: arrival = the form), `apps/mobile/src/feedback.ts` and any other exhaustive switch `npx tsc --noEmit` in `apps/mobile` reports, `apps/mobile/src/api/*` client if the next-step request type is narrowed there
- Modify (e2e): `e2e/tests/support/cards.ts` (`kindOnScreen` learns `meet` by its testID), `e2e/tests/support/sessions.ts` (a `continueMeet(page)` helper), the specs the spec's Testing section names (glosses, progress, next-session, answer-language, meaning-recall, new-meaning, ambiguous-questions)
- Create: `e2e/tests/meet.spec.ts`
- Test: `apps/mobile` jest tests beside the files touched (follow the existing `*.test.ts(x)` pattern for `cardVoice`, `useSession`)

**Interfaces:**
- Consumes: Task 1 (`MeetQuestion`, `{ seen: true }`), Task 4 (the server serves meet cards).

- [ ] **Step 1: Failing unit tests:** `cardVoice(meet)` arrival is the form; `useSession`'s `seen()` sends `{ question_id, seen: true }` and advances with no answer state shown.
- [ ] **Step 2: Implement** `MeetCardView` (spec D1): title **מילה חדשה** (`testID="meet-title"`), the form large (`testID="question-prompt"`, as the read-aloud card) with a `SpeakButton` (`testID="speak-form"`), **אמרו את המילה בקול** under it, the meaning (`testID="meet-meaning"`), one **המשך** button (`testID="meet-continue"`) calling `onSeen`. Reuse `SpeakingCardView`'s read-aloud layout and styles rather than new ones. Wire it in `renderQuestion`.
- [ ] **Step 3:** `cd apps/mobile && npx tsc --noEmit && npx jest`.
- [ ] **Step 4: e2e.** `meet.spec.ts`: save one word, start a session, see `meet-title`, the form and meaning, the arrival utterance of the form, tap **המשך**, no feedback banner, then the word's multiple choice later in the session. Update the listed specs to step through meet cards (`continueMeet`) and to the new card totals. Run `npm run e2e` from the worktree root (each command `cd <worktree> && …`).
- [ ] **Step 5:** Commit `feat(mobile): the meet card (phase 54, spec D1, D6)` and `test(e2e): new words are met first (phase 54)`.

---

### Task 7: The bots

**Files:**
- Modify: `bots/src/answer.ts` (`shown`, `rightText` and `decide` learn `meet`), `bots/src/play.ts` (`answerCard` sends `{ question_id, seen: true }` for a meet card and records it as a study of the word in the bot's memory), the bot memory classes (`bots/src/actr.ts`, `bots/src/fsrsBot.ts`) only as far as "a study" needs
- Test: `bots/src/answer.test.ts`, `bots/src/play.test.ts`

**Interfaces:**
- Consumes: Task 1.

- [ ] **Step 1: Failing tests:** `decide` on a meet card returns a `seen` action (no guess, no outcome counted wrong); `play` answers a meet card with `seen` through its fake API and calls the memory's study path for that word.
- [ ] **Step 2: Implement** (spec D8). Read how a wrong answer's feedback teaches the bot's memory today and make the meet card teach it the same way.
- [ ] **Step 3:** `cd bots && npm test && npm run typecheck`.
- [ ] **Step 4:** Commit `feat(bots): a bot meets a new word (phase 54, spec D8)`.

---

## Finishing

`npm run typecheck`, `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` from the worktree root, then the whole-branch review, then `git-create-pr` and `ci-green` (CLAUDE.md, *Finishing a branch*).
