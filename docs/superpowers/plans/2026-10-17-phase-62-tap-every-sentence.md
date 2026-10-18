# Phase 62 — Tap the words on every sentence card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Victor said "continue till PR": inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gap sentences and the Italian context lines short and built from the learner's words, and map their words to Hebrew. The learner can tap a word before answering and sees every word's translation, plus the whole sentence's, once the answer is final. Each tap is graded by the direction it goes. Every sentence card says what to translate.

**Architecture:**

- **Gap sentences** (the batch's `sentence` task, and `gap`, which now also writes the sentence) and **context lines** (the context call's `target` task) take phase 59's learner words and a 3–6 word limit.
- **The map reuses phase 59's `sentence_words` shape** (a Hebrew run, the target-language words that render it, a list key). It is asked of a mapped `mark` item for each cloze card, and of the `target` item for each context line.
- **The server inverts each map onto the Italian sentence** (`italianWordMap`), stores it in `questions.words`, and serves it.
- **Taps travel on the next-step answer**, are stored in `answer_taps` as in phase 59, and grade written receptive on the Italian cards.
- **The app's `TappableSentence`** learns left-to-right sentences, the gap, and the reveal after answering.

**Tech Stack:** Hono + Drizzle + Postgres (server), Zod in `packages/core`, Expo / React Native (app), Gemini (prompts), Jest, Playwright, MockServer.

**Spec:** `docs/superpowers/specs/2026-10-17-lang-tutor-phase-62-tap-every-sentence-design.md`

## Global Constraints

- In-scope types: `cloze_choice`, `cloze_typed`, `sentence_translation`, `multiple_choice`, `typed_meaning`, `new_meaning` (generated as `multiple_choice`). `reverse_choice`, `typed_translation` and `say_translation` get only D7's wording and label.
- Italian gap sentences and `target` context lines: 3–6 words, a hard limit (`SHORT_SENTENCE_MAX_WORDS = 6`). The `explanation` task keeps 3–12 (asked "4 to 10"). `TRANSLATE_MAX_WORDS` stays 5.
- Priority when rules clash (R5): the sentence points to its word and sense, then short, then the learner's words. The length may rise to 8 only if the evals need it. Never lower `TIER2_THRESHOLD`.
- A bad map never refuses a card. A card with no map works as today.
- A tap on an Italian card's list word grades **written receptive** Again (the evidence type `typed_meaning`). On `sentence_translation` it stays written productive.
- Request fields are optional, so `API_LEVEL` is unchanged (ADR 0012).
- UI copy is Hebrew, and D7's strings are exact.
- No lane is free (all 9 taken): run unit tests, typecheck, `./scripts/check-adrs.sh` and evals locally. Integration and e2e run on CI: push the branch after Task 3.
- A prompt change is timed at full size (`npx tsx tests/ev?l/measureSchema.ts` in `apps/server`, the `--context` flag for the context call).

## Review Focus

1. **Italian word order differs from the Hebrew** (*Questa casa nuova* / *הבית החדש הזה*). Every entry is still located, and the units come out sorted by start. Task 2 test.
2. **A map entry crosses the gap** (*molto grande* / *גדול מאוד* over the gap *molto*). The target is exactly the gap span, and the crossing entry is dropped. Task 2 test.
3. **A free entry's Hebrew holds a word card's answer** (*dopo* → *אחר כך* on a *poi* card). It is dropped. Task 2 test.
4. **A pre-phase card** (no `words`, a `cloze_choice` from the saved example) **answered with `tapped`**. The taps are ignored, and the app shows no tap hint and no per-word reveal. Tasks 3 and 4 tests.
5. **A sentence-initial generated gap on `cloze_choice`.** The wrong options take the blank's capital, as today. Task 1 test.

---

### Task 1: Gap sentences: short, from the learner's words, and generated for `cloze_choice` too

**Files:**
- Modify:
  - `apps/server/src/domain/sentences.ts` (`SHORT_SENTENCE_MAX_WORDS`, used by `validateSentenceItem`)
  - `apps/server/src/domain/distractors.ts`:
    - the `sentence` and `gap` rules
    - `learner_words` sent when any `sentence`, `gap` or `translate` item exists
    - `avoidFor('gap')` = the `sentence` task's list
    - `validateDistractors` for `gap`
    - `generatedContent('cloze_choice')`
  - `apps/server/src/services/sessions.ts`: the checker's `gap` item reads the generated sentence and gap, not `row.example` and `gaps[i]`
- Test: `sentences.test.ts`, `distractors.test.ts`, `services/sessions.prepare.test.ts`

**Interfaces:**
- Produces: `SHORT_SENTENCE_MAX_WORDS = 6`.
- Produces: a `gap` item's `Generated.sentence: SentenceContent` (sentence, translation, gap, alternatives `[]`) alongside `distractors` and `spares`.
- Produces: `generatedContent(row, 'cloze_choice', generated, extras)` reads `generated.sentence`. `extras.gap` is no longer read for it.

Rules:

- **The `gap` rule** now says to write a new sentence exactly as a `sentence` item does (every rule of that task, including `learner_words`). Its distractors follow today's gap rule, for that sentence's own gap. Alternatives stay empty. The user JSON stops sending `sentence`/`blank` for `gap` items, and sends `example`/`example_translation` as the other sentence tasks do.
- **The `sentence` rule** says "3 to 6 words". Its learner-words clause is the `translate` one's, reworded for a target-language sentence: build the sentence from the word and `learner_words` alone, adding another word only where the sentence cannot stand without it, and then a simple one. The rule's "point to the word" sentence stays first (R5).
- **`validateDistractors` for `gap`:** run `validateSentenceItem` first. A failure **refuses** the item with its reason (ruling R7, below). Otherwise run `usableChoices` with `blank` set to the generated gap's text.

- [ ] **Step 1: Tests.**
  - `validateSentenceItem`: a 7-word sentence is refused and a 6-word one kept.
  - The system text's `sentence` rule says "3 to 6 words" and names `learner_words`. The user JSON carries `learner_words` with only a `gap` item present.
  - A `gap` answer:
    - with an invalid sentence is refused with that reason;
    - whose distractor equals the generated gap's text drops that distractor;
    - is valid → `byKey` has `sentence` and three `distractors`.
  - `generatedContent` for `cloze_choice` returns the generated sentence, its translation and gap, and options `[blank, ...]`. A sentence-initial blank capitalises the wrong options.
  - Prepare test: a `cloze_choice` card stores the generated sentence, and the checker's gap item shows it with `___`.
- [ ] **Step 2:** Run `npx jest src/domain` in `apps/server` and the prepare test, and see them fail.
- [ ] **Step 3:** Implement. Update the integration stubs that answer a `gap` item (`apps/server/tests/support`, and `e2e/tests/support/cards.ts`'s `generationStub.gap` gains `sentence`, `gap`, `translation`). Find each with a grep for `gap:` under `tests/support`.
- [ ] **Step 4:** Run `npm test --workspace apps/server` and `npx tsc --noEmit -p apps/server`. They pass.
- [ ] **Step 5:** Time the batch: run `measureSchema.ts` with a 10-item session holding two `gap` and two `sentence` items. Record the numbers in `LlmDistractorsSchema`'s comment.
- [ ] **Step 6:** Commit `feat(server): gap sentences are short, from the learner's words, and written for a cloze choice too`.

### Task 2: Context lines and the Italian word map

**Files:**
- Modify:
  - `apps/server/src/domain/context.ts`:
    - `target` rule: 3 to 6 words, learner words, map
    - `ASKED_WORDS` per task
    - the validation limit per task
    - `contextItemFor`: mapped `mark` items for both cloze types
    - `italianWordMap`
  - `apps/server/src/services/sessions.ts`: store `words` for the cloze cards and the context lines
  - `apps/server/src/repo/questions.ts`: serve them
  - `packages/core/src/api/schemas.ts`:
    - `ClozeChoiceQuestionSchema` and `ClozeTypedQuestionSchema` gain `words` (as `sentence_translation`'s, runs of `sentence`)
    - `ContextSchema` gains `words` (runs of `text`) and `translation: z.string().nullable().optional()`
  - The OpenAPI contract, if generated (ADR 0003: regenerate with the repo's script)
- Test: `context.test.ts`, `sessions.prepare.test.ts`, `repo/questions.test.ts`

**Interfaces:**
- Consumes: `MapWord`, `LearnerWord`, and `found.sentence_words: { hebrew, translation, word }[]` (unchanged schema).
- Produces: `italianWordMap(input: { text: string; translation: string; target: Mark | null; meaning: string; entries: readonly { hebrew: string; translation: string; word: string }[] | undefined; learner: readonly LearnerWord[]; ownGlossId: string }): MapWord[] | null`. Spans are into `text` (the Italian), and each `MapWord.text` is the Hebrew.
- Produces: the served `words` on `cloze_choice`, `cloze_typed` and the Italian `context`, plus `context.translation`. Both are null on the Hebrew-context types.
- Produces: `MarkItem.map` set for `cloze_choice`, `cloze_typed` and `sentence_translation`. `MARKS_SENTENCE` (the columns) is unchanged. A new `MAPPED_SENTENCE` set decides which cards get a mark item.

Rules for `italianWordMap` (spec D2):

- **Locating an entry:** each entry's `translation` (Italian) is found in `text` as the first place that overlaps no kept entry (`findMarks`). Entries are not located left to right, because the order can differ from the Hebrew.
- **Dropping entries:**
  - an entry whose `hebrew` is not in `translation` (`holds`);
  - an entry with an empty side;
  - an unlocated entry.
- **Ordering:** kept entries are sorted by start.
- **The target:** with `target` given, the target entry is exactly `target`'s span. Its `text` is the Hebrew of the first entry overlapping it, or `meaning` if none does. Every other entry overlapping it is dropped.
- **No free reveal:** any non-target entry whose Hebrew `holds` the `meaning` is dropped.
- **List words:** a learner key gives its `glossId`, never the card's own.

For a cloze card, `text` is the gap sentence, `translation` its Hebrew, and `target` the gap. For a context line, `text` is the context, `translation` the `context_translation`, and `target` the context mark.

- **The `target` rule:** the system text asks, "When the item has map, also fill sentence_words as a mark item's, with context_translation as its sentence and context as its translation." Every `target` item has map. `learner_words` is sent when any mapped item exists. The `target` rule asks "3 to 6 words" and refuses more than 6. The `explanation` task keeps "4 to 10" asked and 3–12 allowed.

- [ ] **Step 1: Tests.**
  - Every rule above, with Review Focus 1–3 as named cases.
  - The `target` system text says 3 to 6 and map. The `explanation` text is unchanged (snapshot the line).
  - A 7-word target context is refused, and a 7-word explanation context is kept.
  - `contextItemFor` gives `cloze_choice` a mapped mark item.
  - Prepare: a mapped cloze card and a multiple choice store `words`. A fallback context stores none.
  - `repo/questions` serves `words` without gloss ids, and serves `context.translation` on `multiple_choice`, `typed_meaning` and `new_meaning`, but null on `reverse_choice`.
- [ ] **Step 2:** Run the tests and see them fail. Implement.
- [ ] **Step 3:** Time the context call with ten items, including two mapped clozes and four mapped `target` items (`measureSchema.ts --context`). Record the result in the comment. If it hangs or 400s, stop and record a ruling before going on.
- [ ] **Step 4:** Run `npm test --workspace apps/server`, the core tests, `npx tsc --noEmit` per workspace and `./scripts/check-adrs.sh`. They pass.
- [ ] **Step 5:** Commit `feat(server): context lines from the learner's words, and every Italian sentence mapped to Hebrew`.

### Task 3: Taps on every in-scope card, graded by direction

**Files:**
- Modify:
  - `packages/core/src/api/schemas.ts`: `NextStepRequestSchema`'s `option_index` and `text` shapes gain `tapped: TappedSchema.optional()`
  - `apps/server/src/routes/sessions.ts`: pass `body.tapped` to `answerText` and `submitAnswer`
  - `apps/server/src/services/sessions.ts`:
    - `answerText` passes `tapped`
    - `submitAnswer` classifies taps when `TAPPABLE.has(tappedOn.type)`
  - `apps/server/src/repo/progress.ts` (`tappedMisses`) and `apps/server/src/repo/sessions.ts` (`findAnswersOn`): the evidence type is `CASE WHEN q.type = 'sentence_translation' THEN 'sentence_translation' ELSE 'typed_meaning' END`, joining `questions q ON q.id = a.question_id`
- Test: `apps/server/tests/integration/routes/sessions.taps.test.ts` (extend), the prepare/service unit tests

**Interfaces:**
- Produces: `TAPPABLE: ReadonlySet<QuestionType>`, the six in-scope types, in `domain/taps.ts`.
- `classifyTaps` is unchanged. A target tap never comes from the new cards, since their target is not tappable in the app, but a `target` kind arriving there grades nothing (no `helped`), so check that.

- [ ] **Step 1: Tests (integration).**
  - A `cloze_choice` answer with `tapped` on a list word stores the tap and gives that gloss a written receptive Again (read through `findSessionEvidence` → `gradesFor`). A `sentence_translation` tap still gives written productive.
  - `cloze_typed` with taps, a first wrong try then a second try re-sending them: one miss.
  - A `typed_meaning` judged answer with taps is recorded.
  - A `reverse_choice` with `tapped`: nothing stored.
  - A pre-phase `cloze_choice` (no words) with `tapped`: nothing stored, answered as today.
  - A target-kind tap on a `multiple_choice`: not helped.
  - `findAnswersOn` returns the tap row after its card, typed `typed_meaning`.
- [ ] **Step 2:** Implement. Check `gradesFor('typed_meaning')` maps to written receptive Again on a `wrong` verdict before relying on it.
- [ ] **Step 3:** Run `npm test --workspace apps/server` and typecheck. Integration runs on CI.
- [ ] **Step 4:** Commit `feat(server): taps on every sentence card, a recognition miss on the Italian ones`. Push the branch (CI runs integration and e2e).

### Task 4: The app: tap, reveal, and say what to translate

**Files:**
- Modify:
  - `apps/mobile/src/components/TappableSentence.tsx`: props `direction: 'ltr' | 'rtl'`, `reveal: boolean`, `gap: boolean`
  - `apps/mobile/src/taps.ts` (no change expected beyond types)
  - `apps/mobile/src/quiz.ts`:
    - `wordTappedState` takes taps on `TAPPABLE` types
    - a target tap is refused outside `sentence_translation`
    - `tappedFor` covers `TAPPABLE`
  - `apps/mobile/src/hooks/useSession.tsx`: `select` and `submitText` bodies carry `tapped`
  - `apps/mobile/src/app/session.tsx`: `gapPrompt` uses `TappableSentence` when `words` is set, and `translatePrompt` passes `reveal`
  - `apps/mobile/src/components/ContextLine.tsx`: a tappable variant with the example label and the after-answer translation line
  - `MultipleChoiceView`, `TypedAnswerView` and `NewMeaningPrompt` pass `tapped`, `onTap` and `answered` through
  - `apps/mobile/src/strings.ts`: D7's strings, plus `exampleLabel = 'משפט לדוגמה:'`, `sentenceInHebrew = 'המשפט בעברית:'`, and `tapWordHint` for Hebrew (`'הקישו על מילה כדי לראות אותה בעברית'`)
- Test: `quiz.test.ts`, `taps.test.ts`, the components' tests if they exist

Behaviour (spec D3, D5):

- **Units:**
  - With `gap`, the target unit shows a blank (the width of `SentenceGap`'s) until `reveal`.
  - With `reveal`, every unit with a translation shows it: tapped ones in primary, the target bold in the text colour, the rest muted.
  - `direction` sets the row's direction and the translation's `writingDirection` (the Hebrew under the Italian is right to left).
- **When `reveal` is on:** `reveal = session.answered`. A first wrong try with a pending second try is not answered, so the reveal waits. `cloze_typed`'s phase 38 Hebrew line keeps its rule.
- **The context line on in-scope word cards:**
  - The context line is full size and in the text colour when it has `words`. Otherwise it is muted, as today.
  - The "משפט לדוגמה:" label goes above it on all six word cards.
  - After answering, "המשפט בעברית:" with `context.translation` when it is set.
- **No map:** a card without `words` shows no tap hint and nothing per word, as today.

- [ ] **Step 1: Tests.**
  - `wordTappedState` on `cloze_choice` keeps the index, ignores a target index and a second tap, and is ignored once answered.
  - `tappedFor` returns the taps on all six types, and undefined on `reverse_choice`.
  - `sentenceUnits` over an Italian sentence with a map keeps the text letter for letter.
  - Each D7 string equals the spec's table.
- [ ] **Step 2:** Implement. Run `npm test --workspace apps/mobile` and `npx tsc --noEmit -p apps/mobile`. They pass.
- [ ] **Step 3:** Commit `feat(mobile): tap and reveal on every sentence card, and say what to translate`.

### Task 5: Prompt evals and e2e

**Files:**
- Modify:
  - `apps/server/tests/ev?l/cases.ts` and `run.ts`:
    - `sentence`, `gap` and `target` cases gain Victor's-size learner list (as phase 59's translate cases do)
    - checks: Italian 3–6 words, always; the list share of content words ≥ a threshold set from the first runs; the map located and the target found
  - `e2e/tests/support/mockServer.ts`: `expectContext` items accept `sentence_words`
  - `e2e/tests/sentence-cards.spec.ts`:
    - on a cloze choice, tap a word and see its Hebrew
    - answer, then see every word's Hebrew and the Hebrew line
    - check the body's `tapped`
  - A multiple-choice spec: the same on the context line, plus "המשפט בעברית:"
  - The specs that read the old instructions: change them to D7's strings (grep the old strings under `e2e/tests`)

- [ ] **Step 1:** Add the checks and run the evals locally (a scratchpad script with `npx tsx`, never `npm run` for the eval). Set the threshold from three runs. If the pointing checks drop at 6 words, raise `SHORT_SENTENCE_MAX_WORDS`, up to 8, and record it as a ruling.
- [ ] **Step 2:** Write the e2e changes. Push, and read CI's e2e and eval report. Diff the eval report against master's per row: the `explanation`, `translate` and `meaning` rows must not move.
- [ ] **Step 3:** Commit `test: evals and e2e for taps on every sentence card`.

---

**Ruling R7 (planning).** A `cloze_choice` whose generated sentence fails is **refused**, as a choice card with too few usable options is today (phase 48). It does not fall back to the saved example. A fallback would need a second batch item per card for the saved example's options, and the batch schema caps items at ten, a whole session, and once hung on a change. This replaces D1's "my call".
