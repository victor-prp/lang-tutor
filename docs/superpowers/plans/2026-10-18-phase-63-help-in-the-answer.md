# Phase 63 — Help in the answer: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One help button, the same on every card that has help, at the edge of the place the learner answers.
- On the typed cards, help reads the typing and either marks from the first mistake or gives the next letter
  in grey inside the input.
- Choice cards, listen choice and matching get help.
- Sentence translation loses its button.

**Architecture:**
- **Rules:** pure functions in the app (`typedHelp.ts`, a new `choiceHelp.ts`, `board.ts`, `quiz.ts`), tested
  as units.
- **Grading:** core grades a helped choice as a miss, and the server stores `helped` on a choice row. Every
  reader that turns a stored choice into right or wrong reads `helped`.
- **Views:** a shared `HelpButton` replaces the text links and hint lines.

**Tech stack:** TypeScript; Expo 57 / React Native 0.86 (with react-native-web for e2e); Hono + Drizzle +
Postgres; Jest; Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-lang-tutor-phase-63-help-in-the-answer-design.md`. Read it first:
the D-numbers below are its.

## Global constraints

- The label is always **עזרה** (`strings.help`), with a line bulb before it.
- Enabled look: fill `#EEF2FB`, label `#3B5BDB`, 15 bold, radius 10.
- Disabled look: fill `#F2F2F5`, label `#B4B4C3`.
- Grey letters are `#B4B4C3`. A mark is `#C92A2A` on `#FCEBEB`, underlined.
- A helped pair is border `#3B5BDB`, fill `#EEF2FB`, label `#3B5BDB`.
- `API_LEVEL` stays 5: every new wire field is optional.
- No `Math.random` in `apps/mobile` (ADR 0002).
- Keep the testIDs `typed-help`, `tiles-help` and `speak-help`. Add `choice-help`, `listen-help` and
  `board-help`. Drop `typed-hint` and `speak-hint` as lines; the grey text may reuse the ID.
- No help on read aloud, meet, new meaning, sentence translation (its button) or during the retype.
- Help never writes into the input's value.

## Review focus

The inputs most likely to bite, each pinned by a test in the task that owns it:

1. Typed text with a capital, a curly apostrophe or a double space against the answer: not a mistake. An
   accent is a mistake. (Task 3)
2. An answer with punctuation or spaces (`l'acqua`, `fare colazione`, `po'`): the grey gives the joined step,
   and the marks land on the right typed characters. (Task 3)
3. A typed meaning whose stored Hebrew has niqqud or a maqaf: the comparison uses `normaliseHebrew`'s folding,
   so neither is a mistake. (Task 3)
4. A matching board resumed mid-board (`start > 0`): the helped flags line up with the words sent, and the
   selected distractor meaning falls back to the first unmatched word. (Task 4)
5. A card's second try, and "can't speak now": `given` and `pressed` survive, and a press that only marked
   still sends `helped: true`. (Task 4)

---

### Task 1: Core and the wire, a helped choice (D10)

**Files:**
- Modify: `packages/core/src/domain/quiz.ts`: `AnswerInput`, `HELPED`, `evaluate`
- Modify: `packages/core/src/api/schemas.ts:484-489`, the `option_index` branch
- Test: `packages/core/src/domain/quiz.test.ts`, `packages/core/src/api/schemas.test.ts`

**Interfaces:**
- **Produces:**
  - `AnswerInput`'s `{ option_index: number; helped?: boolean }`
  - `takesHelp` is true for `multiple_choice`, `reverse_choice`, `cloze_choice`, `listen_choice` and
    `matching`. It stays false for `new_meaning`.

- [ ] **Step 1: Write the failing tests.** In `quiz.test.ts`:
  - Extend the `TAKES_HELP` table so the five types are `true` and `new_meaning` is `false` (twelve true in
    all).
  - Add `it.each` over the five types: the right `option_index` with `helped: true` gives
    `is_correct: false`, and with `helped: false` gives `true`.
  - A `new_meaning` with `helped: true` stays right.

  In `schemas.test.ts`: `NextStepRequestSchema` parses `{ question_id: 'q', option_index: 1, helped: true }`
  and keeps `helped`.
- [ ] **Step 2: Run the tests and see them fail.** Run
  `npm test --workspace packages/core -- quiz schemas`. Expected: FAIL on the new rows.
- [ ] **Step 3: Implement.**
  - Add the five types to `HELPED`.
  - The `option_index` variant gains `helped?: boolean`.
  - `evaluate`'s choice branch sets `is_correct: !helpedOn(question, answer) && option_index === correct_option`.
  - The schema's `option_index` object gains `helped: z.boolean().optional()`, with a phase 63 comment.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command plus
  `npm run typecheck --workspace packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(core): a helped choice is a miss`.

### Task 2: The server stores and reads a helped choice (D11)

**Files:**
- Modify: `apps/server/src/routes/sessions.ts:399`, passing `helped`
- Modify: `apps/server/src/services/sessions.ts:1013-1028`, so a choice row carries `helps`
- Modify: `apps/server/src/repo/sessions.ts`:
  - `insertAnswer`: its `displayIndex` branch takes `helped?: boolean | null`
  - `findAnswersOn`'s SQL selects `coalesce(a.helped, false) AS helped` (`false` on the tap rows)
  - `loadSession` selects `helped`, and a choice's `is_correct` is `chosen.is_correct && !helped`
- Modify: `apps/server/src/repo/progress.ts`:
  - `AnswerRow` gains `helped: boolean`
  - `decodeAnswer`: `correct: option.is_correct && !row.helped`
  - `tappedMisses` selects `false AS helped`
  - `findSessionEvidence` drops its now duplicate `helped` select, or keeps it consistent
- Modify: `apps/server/src/db/schema.ts`: drop the check `answers_helped_text`, and name the choice cards in
  the `helped` comment
- Create: the migration, by `npm run db:generate --workspace apps/server`. It is expected to be
  `0044_*.sql` with `ALTER TABLE "answers" DROP CONSTRAINT "answers_helped_text"`.
- Test: `apps/server/tests/integration/routes/sessions.helped.test.ts`

**Interfaces:**
- **Consumes:** Task 1's `AnswerInput` and schema.
- **Produces:** a stored choice row with `helped`. `decodeAnswer` and `loadSession` read it as wrong.

- [ ] **Step 1: Write the failing integration tests.** In `sessions.helped.test.ts`:
  - On each of `multiple_choice`, `reverse_choice`, `cloze_choice` and `listen_choice`, a right option sent
    with `helped: true`:
    - the stored row is `helped = true`
    - the step's record is `is_correct: false`
    - at the session's end, the gloss's memory grade is AGAIN, as for a wrong option, read the way the file's
      phase 56 tests read grades
  - The same option unhelped stays right.
  - A matching word sent with `helped: true` is stored helped, and its evidence is wrong.
  - Move "stores null on a card that takes no help, even when sent" to `new_meaning`.
- [ ] **Step 2: Run the tests and see them fail.** Run
  `npm run test:integration -- --selectProjects=integration --runTestsByPath apps/server/tests/integration/routes/sessions.helped.test.ts`.
  If the root script won't pass the flags, run the workspace's own `test:integration` through
  `scripts/lane-env.sh`. Expected: FAIL.
- [ ] **Step 3: Implement the files above,** then run `npm run db:generate --workspace apps/server` and check
  the generated SQL drops only that check.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command, the whole `apps/server` integration
  project, and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(server): a helped choice is stored and read as a miss`.

### Task 3: The typed press rule, choice rule-out, listen letters (D3, D6, D7)

**Files:**
- Modify: `apps/mobile/src/typedHelp.ts`
- Create: `apps/mobile/src/choiceHelp.ts`
- Test: `apps/mobile/src/typedHelp.test.ts`, `apps/mobile/src/choiceHelp.test.ts`

**Interfaces:**
- **Produces**, in `typedHelp.ts`:
  - `stepsOf(answer: string): number`, which is `wholeForm` renamed or aliased; keep `wholeForm`.
  - `pressTyped(answer: string, typed: string, given: number, hebrew: boolean): { given: number; markFrom: number | null }`
    - `markFrom` is the index into `typed` of the first wrong character.
    - When `markFrom` is set, `given` is unchanged.
    - Otherwise `given` becomes `max(given, stepsCovered(typed)) + 1`, capped at the step count.
  - `typedHint(answer: string, typed: string, given: number, hebrew: boolean): { ghost: string; more: boolean } | null`
    - `ghost` is the given text past what is typed.
    - `more` is true while the answer goes on beyond the given steps, and shows as `…`.
    - It is null when `typed` is not a start of the answer.
  - `typedHelpDone(answer: string, typed: string, given: number, hebrew: boolean): boolean`
- **Produces**, in `choiceHelp.ts`:
  - `ruledOut(question: { id: string; options: readonly string[]; correct_option: number }, presses: number): number[]`
    - Wrong indices ordered by an FNV-1a hash of `` `${id}:${index}` ``, and the first `presses` of them taken.
    - Never more than `options.length - 2`.
  - `choiceHelpDone(question, presses): boolean`

- [ ] **Step 1: Write the failing tests.**
  - In `typedHelp.test.ts`, for `pressTyped`, `typedHint` and `typedHelpDone`, on the storyboard's cases with
    the answer `colazione`:
    - `''` with `given` 0 → `given` 1, and the hint is `c` with more
    - `c` with `given` 2 → the hint is `o` with more
    - `calazo` → `markFrom` 1
    - `colazone` → `markFrom` 5
    - `colazi` → `given` 7, and the hint is `o`
    - `colazione` → done
    - `colazionee` → `markFrom` 9
    - Review focus 1: `Co`, and a curly `’` against `'`, are right; `è` against `e` is wrong.
    - Review focus 2: `l'acqua` and `fare colazione` give `l'a` and `fare c` as one step each; a double space
      typed is folded.
    - Review focus 3: with `hebrew: true`, `אֲרוּחָה` typed against `ארוחה` is right, and a maqaf against a
      space is right.
  - In `choiceHelp.test.ts`:
    - `ruledOut` never includes `correct_option`
    - it gives one, then two, then still two on four options
    - it is the same for the same id
    - the first pick differs across at least two ids
    - `choiceHelpDone` is true at two
- [ ] **Step 2: Run the tests and see them fail.** Run
  `npm test --workspace apps/mobile -- typedHelp choiceHelp`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Folding:** each character goes through NFC, lowercase and the apostrophe fold, as `normaliseTyped`
    does. For `hebrew`, drop points, read a maqaf or punctuation as a space, and drop format marks, as
    `normaliseHebrew` does.
  - **Runs of space** fold to one, on both sides.
  - **Mapping:** keep a map from folded positions back to typed indices, so `markFrom` indexes the typed
    string.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(mobile): help reads the typing, rules out options`.

### Task 4: Session state, the wire from the app, matching help, banners (D3, D8, D10, D12)

**Files:**
- Modify: `apps/mobile/src/quiz.ts`
  - `QuizState` gains:
    - `helpPressed: boolean`, kept like `help`
    - `helpMarks: { text: string; from: number } | null`, reset on a new card and on a second try's entry
  - `helpPressedState(current, typed?: string)`
  - `helpedFor`: `help > 0 || helpPressed`, and the choice types
- Modify: `apps/mobile/src/hooks/useSession.tsx`
  - `pressHelp(typed?: string)`
  - `answerWith` attaches `helped` to an `option_index` too
  - `submitBoard(firstAttempts: number[], helped: boolean[])` sends `helped` per word
- Modify: `apps/mobile/src/board.ts`
  - `BoardState` gains `helped: boolean[]`
  - `helpBoard(state, question): BoardState`
  - `boardHelpDone(state): boolean`
  - `helpedWords(state): boolean[]`, sliced like `firstAttempts`
- Modify: `apps/mobile/src/feedback.ts`
  - `CardAnswer`'s board variant gains `helped?: boolean[]`
  - `unhelped` strips `helped` from an `option_index`
  - `helpedOr` treats a right choice as right
  - the board count leaves helped words out
- Test: `quiz.test.ts`, `board.test.ts`, `feedback.test.ts`

**Interfaces:**
- **Consumes:** Task 3's `pressTyped` and `helpText`.
- **Produces**, used by Task 5's views:
  - `session.pressHelp(typed?: string)`
  - `session.help`, `session.helpPressed` and `session.helpMarks`
  - `session.submitBoard(firstAttempts, helped)`
  - `helpBoard`
  - `boardHelpDone`

- [ ] **Step 1: Write the failing tests.**
  - In `quiz.test.ts`:
    - On a typed card, `helpPressedState(state, 'calazo')` sets `helpMarks` `{ text: 'calazo', from: 1 }`,
      `helpPressed: true`, and leaves `help` unchanged.
    - With `'colazi'` it sets `help` to 7.
    - Without `typed` it adds one step (spoken, listen, choice).
    - `helpedFor` is true after a press that only marked.
    - On `multiple_choice`, `helpedFor` is false before a press and true after.
    - Review focus 5: a second try of the same card keeps `help` and `helpPressed`; the next card resets
      `help`, `helpPressed` and `helpMarks`.
    - `nextStepRequest` with `{ option_index: 2, helped: true }` sends `helped`.
  - In `board.test.ts`:
    - `helpBoard` matches the selected word, else the selected meaning's word, else the first unmatched word.
    - Review focus 4: the distractor meaning selected falls back.
    - The helped word's `first` is its correct meaning when untried, and `helped` is true.
    - With `start: 2`, `helpedWords` slices from 2.
    - `boardHelpDone` once all are matched.
  - In `feedback.test.ts`:
    - a right option with `helped: true` gives tone `other` and `feedbackHelped`
    - a wrong one with help is wrong
    - a board of 4 with one helped word, and the other three right first time, gives
      `boardResult(3, 4)` and tone `wrong`
- [ ] **Step 2: Run the tests and see them fail.** Run
  `npm test --workspace apps/mobile -- quiz board feedback`. Expected: FAIL.
- [ ] **Step 3: Implement the files above.**
  - `wordTappedState`'s target tap also sets `helpPressed: true`.
  - `submitBoard` sends `{ question_id, option_index, helped: helped[index] }`.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command plus
  `npm run typecheck --workspace apps/mobile`. Expected: PASS. Session code that hasn't been updated may break
  the typecheck until Task 5; if so, fix the call sites now with today's behaviour.
- [ ] **Step 5: Commit** with `feat(mobile): the session's help state, sent on choices and boards`.

### Task 5: The views (D1, D2, D4–D9)

**Files:**
- Create: `apps/mobile/src/components/HelpButton.tsx`
  - Props: `{ onPress: () => void; disabled: boolean; testID: string }`
  - Ionicons `bulb-outline` from `@expo/vector-icons`
  - Install: `env -u npm_config_allow_scripts npx expo install @expo/vector-icons` in `apps/mobile`. Then
    confirm with `npx expo-updates fingerprint:generate` (or `npx @expo/fingerprint`), before and after, that
    the fingerprint is unchanged, and note the result in the PR.
- Modify: `apps/mobile/src/components/TypedAnswerView.tsx`
  - The button goes inside the input row at the right edge.
  - The grey letters and the marks are drawn in a `Text` layer aligned with the `TextInput`.
  - The `typed-hint` line and the action-column link go.
  - No help when `question.type === 'sentence_translation'`.
- Modify: `apps/mobile/src/components/LetterTilesView.tsx`: the built row becomes a box with the button at its
  end.
- Modify: `apps/mobile/src/components/SpeakingCardView.tsx`: a dashed letters box above the mic, with the
  button at its end.
- Modify: `apps/mobile/src/components/MultipleChoiceView.tsx`
  - A help row above the options; `ruledOut` options fade and are disabled.
  - On `listen_choice`, a dashed letters box under `ListenPrompt` instead.
- Modify: `apps/mobile/src/components/MatchingBoardView.tsx`: a help row above the columns; helped pairs in
  blue; `onComplete(firstAttempts, helped)`.
- Modify: `apps/mobile/app/session.tsx`: wire `help`, `pressHelp` and the new props, and drop help on
  sentence translation.
- Modify, if needed: `apps/mobile/src/components/TappableSentence.tsx`. A tapped practised word on a sentence
  translation shows its Italian under it. A `'mark'` card shows `question.answer`.

**Interfaces:**
- **Consumes:** Tasks 3 and 4.

- [ ] **Step 1: Implement the views.** Follow the approved mockups (`help-v4a-marks-v4.html`,
  `help-all-cards.html`) and the global constraints.
- [ ] **Step 2: Check them.** Run `npm run typecheck`, `npm test`, and `npm run lint:arch`. Expected: PASS.
- [ ] **Step 3: Look at the cards on the web build.** Start the lane with `npm run server` and
  `npm run mobile`, open the web app at a phone viewport, and screenshot each card's help. Expected: each card
  matches the mockups.
- [ ] **Step 4: Commit** with `feat(mobile): one help button in the answer, on every card`.

### Task 6: e2e

**Files:**
- Modify: `e2e/tests/help.spec.ts`, `meaning-recall.spec.ts`, `sentence-cards.spec.ts`, `speaking.spec.ts`,
  `listening-variety.spec.ts`
- Test: new cases in `help.spec.ts` for choice, listen choice and matching help.

- [ ] **Step 1: Update the existing help assertions** to the new controls.
  - **The typed card,** with its keyboard open:
    - press `typed-help` and see the grey letters
    - type a wrong letter, press, and see the marks
    - the body carries `helped: true`
  - **Tiles, spoken and dictation:** the same testIDs, with the hint text now inside the box.
  - **Sentence translation:**
    - no `typed-help`
    - a tap on the practised word still sends `helped: true`, and shows its Italian under it
- [ ] **Step 2: Add the new cases.**
  - **A choice card:**
    - `choice-help` twice: two options are disabled, and the third press is disabled
    - the body is `helped: true`, and the banner is **נכון, עם עזרה** on the right option
  - **Listen choice:** `listen-help` shows the first letter.
  - **Matching:**
    - `board-help` matches a pair in blue
    - the bodies carry `helped: true` on that word only
  - **Layout:** at a 390 × 844 viewport, on cloze typed with its sentence hint opened, `typed-help` is inside
    `typed-input`'s row and in the viewport.
- [ ] **Step 3: Run the specs.** Run `npm run e2e -- help meaning-recall sentence-cards speaking listening-variety`,
  then all of `npm run e2e`. Expected: PASS.
- [ ] **Step 4: Commit** with `test(e2e): help in the answer on every card`.

### Task 7: Finish

- [ ] **Step 1: Run the full suite:** `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e`.
  All must pass.
- [ ] **Step 2: The final review** of the whole branch against the spec. Fix what it finds, and record the
  rulings in the spec's Rulings section.
- [ ] **Step 3: Open the PR** with `git-create-pr`, then run `ci-green`. The PR body's "Left for Victor" lists:
  - the lane 0 migration (`npm run db:migrate`, main checkout)
  - the phone check after the merge (R10)
