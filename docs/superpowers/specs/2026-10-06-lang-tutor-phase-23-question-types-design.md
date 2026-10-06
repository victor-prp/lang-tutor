# Phase 23 — More question types

- **Status:** Implemented on branch `phase-23-question-types`. Designed autonomously on
  2026-10-06: Victor scoped the phase in the one-pager, then asked for the design to be made
  without questions ("I trust your decisions; user experience and good architecture are very
  important"), planned, built and opened as a PR. Every decision is in §1 with its reason, so each
  one can be overturned in review. Deviations found while building: `QuestionType` lives in
  `packages/core/src/domain`, not `api/types.ts`, which ADR 0003 R3 keeps to `z.infer`s;
  `AnswerRecord` gains an optional `verdict`, so the server reads the verdict `evaluate` gave
  rather than judging twice; the results' missed rows read word → meaning whichever way the card
  asked (`missedPair`); and the banner's line is a first-strong isolate, so the e2e helper that
  strips isolates now strips U+2066–U+2069.
- **Date:** 2026-10-06
- **Source:** the one-pager `drafts/2026-10-06-question-types-one-pager.md`. `drafts/` is
  gitignored, so everything this spec depends on is restated below.
- **Builds on:** phase 19 (list-built sessions, distractors generated in a background job) and
  phase 20 (five knowledge dimensions per saved sense, `LIVE_DIMENSIONS`, and the evidence table in
  its §3, written for exactly the exercise types this phase adds).
- **Touches:** ADR 0003 (the wire's `Question` becomes a union, `NextStepRequest` a union). No new
  ADR and no new check script.

## Goal

Every question today is the same card: the target word, four Hebrew meanings, pick one. That
proves recognition and nothing else, so two of the three written dimensions phase 20 stores,
`written_productive` and `spelling`, can never leave "not practised". And ten identical cards make
a session feel the same every time. Both problems hold for every target language.

This phase adds two question types, Hebrew → target as multiple choice and Hebrew → target typed,
and mixes them with today's card in every session built from the saved list.

**Done means:**

1. A list session mixes three types: today's card, Hebrew → target choice and Hebrew → target
   typed. Two cards in a row are never the same type, unless the session has a single word.
2. A correct typed answer moves `written_productive` above "not practised"; an exact one moves
   `spelling` too. Hebrew → target choice alone takes `written_productive` no higher than level 3.
3. A typed near miss counts as correct, shows the right spelling, and does not move `spelling`.
4. The badge averages the three written dimensions, as phase 20's rule says once they are live
   (D7). No per-dimension level ever goes down.
5. Each outcome above is checked by an automated test. `npm test`, `npm run test:all`,
   `npm run lint:arch`, `npm run e2e` and `npm run eval` pass, the last without lowering
   `TIER2_THRESHOLD`.

## Scope

**In:**
- the `reverse_choice` and `typed_translation` question types, end to end;
- the type mix of a list session;
- the typed-answer judge, shared by the app and the server;
- `written_productive` and `spelling` going live, and the results naming the dimension that rose;
- the generation prompt asking for target-language wrong options and accepted alternatives, with
  eval cases for both.

**Out:**
- voice: listening, dictation, speaking;
- cloze, or anything else that needs an example sentence per word;
- variety-only types: matching pairs, letter tiles, timed rounds;
- changes to the seeded first session, which stays today's card only;
- a setting to choose or switch off types;
- an in-app keyboard: the phone's own keyboard for the target language is used;
- choosing a word's type from its level (D3);
- typed meaning recall, target → Hebrew typed, which needs a model to judge free Hebrew;
- a letter-by-letter diff of a near miss;
- an in-app announcement of the badge recalibration (D7).

---

## 1. Decisions

**D1. Three question types, a discriminated union on `type`.** `multiple_choice` keeps its name,
shape and meaning (target word → Hebrew meaning), so the seed, every stored row and every old
session read exactly as before. The two new types are `reverse_choice` (Hebrew meaning → pick the
target word) and `typed_translation` (Hebrew meaning → type the target word). Distinct types,
rather than a `direction` flag on `multiple_choice`, because every consumer that cares switches on
`type`: the evidence table (D6), the app's renderer, the judge. A flag would make each of those a
two-level switch, and the compiler's exhaustiveness check would cover only the first level.

**D2. A list session's types follow its positions: choice, reverse choice, typed, repeating.**
The picked senses are already in random order (`pickSenses`), so position `i` gets
`TYPE_CYCLE[i % 3]` and the order is not shuffled again. Only the options are shuffled, as today.
So:

- two cards in a row always differ once a session has two words, and every session of three or
  more has all three types (one-pager Done means 1);
- every session opens with recognition, the easiest card, and each run of three climbs from
  recognition to recall: a warm-up rather than a cold start on a typed card;
- which word gets which type is random, so over sessions every saved word meets every type;
- a ten-word session is 4 + 3 + 3, and an e2e test knows the type of every position.

A random type per card was rejected: it makes "never two in a row" a retry loop, and it lets a
session open on a typed card.

**D3. A word's type does not depend on its level.** This answers the one-pager's open question.
Phase 20 recorded progress without acting on it, and phase 19 kept "any ordering by past results"
out. Choosing types by level is half of what a spaced-repetition phase will decide (what to
practise, and how), and building that half now would pre-empt it. A word saved a minute ago may
come up as a typed card. That is the recall test the feature exists for, and with feedback a
failed attempt still teaches (Kang et al. 2007, cited in phase 20). The near-miss credit, the
lemma rule and "show the answer" (D5, D9) keep it from feeling punitive.

**D4. Reverse and typed cards show the Hebrew meaning, and the part of speech under it.**
The prompt is the variant's own rendering, the same `dict_var_translations` text today's card
offers as its right answer. Hebrew without points is ambiguous (`ספר` is a book, a barber, or
"counted"), so the card adds the lexeme's part of speech in Hebrew, using phase 21's
`strings.partOfSpeech`. The data already exists and the cost is one muted line.

The prompt is **stored on the question** (`questions.prompt`), not joined from the dictionary at
read time. A phase 13 repair can rewrite a rendering, and a question is a record of what was asked.
Today's card already stores its right answer as option text for the same reason.

**D5. A typed answer gets one of four verdicts, from one pure function in `packages/core`.**
`judgeTyped(question, text)` compares normalised text. Normalising trims, collapses spaces,
lowercases, applies NFC, folds the typographic apostrophes `’ ‘ ʼ` to `'`, removes Cyrillic stress
marks, drops a trailing `.,!?;:…`, and ignores one leading article or `to` (`il libro`, `to go`,
`l'acqua`) when the rest matches. Then:

| Verdict | When | Counts in the score |
|---|---|---|
| `exact` | the saved form, or its lemma | correct |
| `alternative` | one of the generated alternatives: another word that also translates the prompt (D8) | correct |
| `near_miss` | the form or lemma with only its diacritics different (`perche`, `елка`), or one edit away (insert, delete, substitute, swap two neighbours) when that word has at least five letters | correct |
| `wrong` | anything else, including an empty answer | wrong |

- **The lemma counts as exact** because the phase practises words, not inflection: a learner who
  saved `parlo` and types `parlare` for `מדבר` knows the word. Conjugation practice is out (phase
  22's Out list).
- **An alternative is right but is not this word**, so it counts in the score and gives no
  evidence about this sense (D6). The feedback names the practised word, so the learner leaves
  with it.
- **Diacritics are spelling** (phase 22 D3, `e`/`è`), so a missing accent is a near miss and
  never exact. Stress marks are not spelling (phase 16), so they are removed before comparing.
- The five-letter floor is phase 20's: below it, one edit is too often another word (`bat`/`bad`).
- An alternative is checked before a near miss, so a real synonym is never reported as a typo.

**D6. Evidence per type and verdict.** This fills in phase 20's §3 table, which was written for
these types, and follows its rules: productive success credits receptive at full weight, only
successes are credited downward, and recognition-format evidence caps a productive dimension at 3.

| Type | Verdict | `written_receptive` | `written_productive` | `spelling` |
|---|---|---|---|---|
| `multiple_choice` | correct / wrong | ✓ / ✗ | — | — |
| `reverse_choice` | correct | ✓ | ✓ capped at 3 | — |
| `reverse_choice` | wrong | — | ✗ | — |
| `typed_translation` | exact | ✓ | ✓ | ✓ |
| `typed_translation` | near miss | ✓ | ✓ | ✗ |
| `typed_translation` | alternative | — | — | — |
| `typed_translation` | wrong | — | ✗ | — |

A wrong typed answer says nothing about spelling. Spelling is precision in a form the learner
recalled, and a failure to recall is already the productive failure.

**D7. `written_productive` and `spelling` go live, and the badge is their mean with
`written_receptive`.** Phase 20 decided, in its dialogue with Victor, that the badge is the mean
over live dimensions. It also accepted in advance that "a dimension going live drops badges once",
as a deliberate recalibration. The one-pager's line "the badge still reads passive-text" came from
the earlier research draft, and this spec follows phase 20 instead:

- an overall badge that ignored writing would make this phase's practice invisible on the list,
  which is the opposite of what the phase is for;
- phase 20 built `LIVE_DIMENSIONS` as the one switch for exactly this moment. The list's SQL, the
  detail and the results all read it, so the change is one line, not a second badge rule;
- the drop is at its smallest now. Progress started on 2026-10-05, so no row is above level 3,
  and a word at (3, 1, 1) reads 2.

Phase 20 also said the drop would be "announced in the app". A one-time notice needs a device
store and a dismissed state, for a one-level shift on a two-day-old feature with one learner. The
PR description announces it instead, and the word detail shows the reason permanently: three live
dimensions where there was one.

**D8. One generation call, three tasks.** The prepare-session job still makes one model call per
session (phase 19), and each item now names its task:

- `meaning` (today's card): three wrong Hebrew meanings, unchanged;
- `word` (reverse choice): three wrong target-language words, under the same "plausible and
  never right" rules;
- `typed`: no wrong options; instead, every other target-language word or phrase that translates
  the Hebrew equally well in this sense, up to five. This is what lets `large` be right for `גדול`
  when the saved word is `big`.

The response keeps its shape. `distractors` relaxes from exactly three to at most three, and
domain validation demands three for the choice tasks. `alternatives` is a new optional field,
following the precedent of `LlmTranslationSchema.alternatives`: a missing or bad list must never
fail a session, so it is cleaned (empty strings, Hebrew text, copies of the answer and duplicates
dropped; at most five kept) rather than validated. A `word` item's wrong options must contain no
Hebrew letter, and must not be another item's form when that item has the same Hebrew prompt,
mirroring the sibling rule `meaning` items already have. The `three wrong answers` marker stays in
the prompt, so MockServer stubs still tell this call from a translation.

**D9. The typed card.** The app judges locally with the same `judgeTyped` the server uses, so
feedback is instant, as it is on today's card (the client already holds `correct_option`). The
server judges again, stores the verdict, and its stored verdict is what scoring and progress read.
The two cannot disagree, because they run one function over the same data.

- The input is left-to-right, with autocapitalise, autocorrect and spellcheck off, so the phone
  neither "fixes" a near miss into a right answer nor a right answer into a wrong one. It is
  focused on arrival. Return submits.
- **בדיקה** submits and is disabled while the input is empty. **הצגת התשובה** submits an empty
  answer, which is wrong: a learner with no idea is never forced to type nonsense.
- After submitting, the input locks, its border takes the verdict's colour, and the keyboard is
  dismissed so the feedback banner is visible.
- The banner says **נכון!**; **כמעט! כך כותבים:** with the form for a near miss;
  **נכון! המילה שתרגלנו:** with the form for an alternative; or **התשובה הנכונה:** with the form
  for a wrong answer. A near miss uses the correct colours, because it counts as correct.
- The instruction names the language from the active enrollment: **כתבו את המילה באיטלקית**.

**D10. The reverse-choice card is today's card turned round.** It reuses `MultipleChoiceView`
with the prompt right-to-left and the options left-to-right, under the instruction
**איך אומרים באיטלקית?**. The four-equal-heights layout and the feedback are unchanged.

**D11. Results name the dimension that moved.** With the badge a mean of three dimensions, a
correct card on a new word often moves one dimension without moving the badge (new word, today's
card right: (2, 1, 1), still 1). Unmarked, that reads as "I was right and nothing happened", which
is phase 20's stall risk made routine. The research draft had the answer: "the post-session screen
shows the level of the dimension the session exercised". Each results item therefore carries
`raised`, the live dimensions that rose in this session. A row whose badge rose keeps phase 20's
**עלתה לרמה X** tag. A row where only a dimension rose gets a quieter **התקדמות: כתיבה** tag and
sorts after the badge risers.

**D12. A typed answer is stored as text plus verdict.** `answers.selected_option_position`
becomes nullable, and `answers.typed_text` and `answers.verdict` are added. A check makes each
answer exactly one of the two kinds. The verdict is stored rather than recomputed from the text,
so the history records what the learner was told. Phase 20's recompute replays stored verdicts,
which fits its purpose: it exists for when the step rule changes, not the judge.

**D13. A typed question stores its alternatives and no options.** `questions.options` becomes
nullable. `questions.alternatives` (`text[]`, at most five) and `questions.prompt` are added. A
check enforces each type's shape (§2). The answer is not stored, because it is the variant's form,
which the existing join already reads for today's card. `session_questions.option_order` stays
`NOT NULL` and holds `{}` for a typed question: it records the per-session shuffle, and a typed
card has none.

**D14. A mismatched answer is a 400.** `option_index` sent for a typed question, or `text` for a
choice question, is a malformed request, not a desync. It gets a new domain outcome
(`wrong_answer_kind`) and error (`AnswerKindMismatch`), mapped to 400 beside `OptionOutOfRange`.

---

## 2. Changes

### `packages/core`

- `api/schemas.ts`: `ReverseChoiceQuestionSchema` (`id`, `type`, `vocab_term_id`, `question`,
  `part_of_speech`, `options`, `correct_option`); `TypedTranslationQuestionSchema` (`id`, `type`,
  `vocab_term_id`, `question`, `part_of_speech`, `answer`, `lemma`, `alternatives`);
  `QuestionSchema` becomes `z.discriminatedUnion('type', …)`. `NextStepRequestSchema` becomes a
  union of the choice body and `{ user_id, question_id, text }`, where `text` is at most 100
  characters and may be empty. `TypedVerdictSchema` holds the four verdicts.
  `SessionProgressItemSchema` gains `raised: KnowledgeDimension[]`. `LlmDistractorsSchema`:
  `distractors` at most three, plus optional `alternatives`.
- `domain/quiz.ts`: `evaluate(question, response)` takes `{ option_index } | { text }`. A typed
  answer's `is_correct` is "verdict is not wrong". Missed questions read the right answer per
  type.
- `domain/typed.ts` (new): `normaliseTyped`, `judgeTyped`, and the edit-distance helper.
- `domain/progress.ts`: `LIVE_DIMENSIONS = ['written_receptive', 'written_productive', 'spelling']`.

### Server

- **Migration 0015** (generated, then the data-preserving parts checked by hand):
  - `questions`: `prompt text`, `alternatives text[]`, `options` drops `NOT NULL`, and the
    options check becomes `options IS NULL OR question_options_valid(options)`;
    `questions_type_known` admits the three types; `questions_shape_valid` requires
    `multiple_choice` to have options and neither prompt nor alternatives, `reverse_choice` to
    have options and a prompt, and `typed_translation` to have a prompt and alternatives but no
    options, with `cardinality(alternatives) <= 5`.
  - `answers`: `selected_option_position` drops `NOT NULL`, plus `typed_text text` and
    `verdict text`; `answers_kind_valid` requires exactly one of option and text, with a verdict
    exactly when there is text; `answers_verdict_known`; `typed_text` at most 100 characters.
  - Every existing row satisfies the new checks unchanged: all questions are `multiple_choice`
    with options, and all answers have an option.
- `domain/session.ts`: `TYPE_CYCLE` and `typeFor(position)`. `step(record, questionId,
  response)` gains the `wrong_answer_kind` outcome, and `out_of_range` applies to choice
  questions.
- `domain/progress.ts`: `AnsweredQuestion` carries `verdict` instead of `correct`, and
  `evidenceFor` implements D6. `progressChanges` returns `raised` per sense.
- `domain/distractors.ts`: `GenerationContext` gains `task`. `buildDistractorPrompt` writes the
  three-task prompt with both languages' writing rules, and `validateDistractors` validates per
  task and returns options or alternatives per key. `optionsFor` serves both choice tasks.
- `repo/questions.ts`: `questionFrom` builds all three shapes from one row (prompt, options,
  alternatives, the variant's form, the lexeme's lemma and part of speech).
  `insertGeneratedQuestions` writes all three. `findGenerationContext` is unchanged apart from
  the task, which the service assigns.
- `repo/sessions.ts`: `insertSessionQuestions` writes `{}` for a typed question. `insertAnswer`
  takes a choice index or a typed text and its verdict. `loadSession` rebuilds both kinds of
  answer record.
- `repo/progress.ts`: `findSessionEvidence` reads each answer's verdict: from its option for a
  choice, from the stored verdict for typed. `findSnapshot` reads the Hebrew from the prompt for
  reverse and typed questions, so the results always show form → meaning.
- `services/sessions.ts`: `prepareSession` assigns a task per position, keeps the pick order, and
  shuffles options only. `submitAnswer(sessionId, questionId, response)` judges a typed answer
  with `judgeTyped` before inserting it.
- `routes/sessions.ts`: next-step accepts either body, maps `AnswerKindMismatch` to 400, sends
  `raised`, and describes the three types in the published API.
- `db/progressRecompute.ts`: unchanged in logic; it reads evidence through the repository above.

### Mobile

- `components/TypedAnswerView.tsx` (new): the typed card of D9.
- `components/MultipleChoiceView.tsx`: takes the instruction and the two text directions as
  props.
- `components/FeedbackBanner.tsx`: takes a feedback object (title, line, correct or wrong)
  instead of `isCorrect`/`correctAnswer`.
- `feedback.ts` (new, pure): `feedbackFor(question, response)` returns the banner's content and
  the verdict.
- `hooks/useSession.tsx`: the answer in state becomes `{ option_index } | { text }`; `select` and
  `submitText` both send next-step; `answered` and `verdict` derive from it.
- `app/session.tsx`: the exhaustive switch over the three types, `keyboardShouldPersistTaps`, and
  keyboard avoidance.
- `app/results.tsx` and `progress.ts`: the `raised` tag and ordering of D11. Missed rows show the
  prompt and the right answer whatever the type.
- `strings.ts`: the instructions, verdict titles, **בדיקה**, **הצגת התשובה**, and
  `dimensionsRaised`.

### Eval

- `DistractorCase` items gain `task` (default `meaning`), with `synonyms` meaning right answers
  in the language of that task's options.
- Tier 1 per task: choice items have three distinct wrong options in the options' script, none
  the answer; typed items' alternatives contain no Hebrew and never repeat the answer.
- Tier 2: a choice item's wrong options include no known right answer (unchanged), and a typed
  item lists at least one of its known alternatives.
- New cases: a reverse batch per target language, with target-language synonyms that must not be
  offered; a typed batch with well-known synonyms (`big`/`large`, `casa`/`abitazione`,
  `быстро`/`скоро`); one mixed batch shaped like a real session.

---

## 3. Testing

### Unit

- **core:** `judgeTyped` over the verdict table, including the lemma, an article, a typographic
  apostrophe, a stress mark, a missing accent, a swap, the five-letter floor, an alternative
  beating a near miss, and empty input. `evaluate` per type and response kind. The `Question`
  union parses all three shapes.
- **server domain:** `typeFor` for positions 0–9; `evidenceFor` for every row of D6; `advance`
  holding the cap for reverse-only evidence; `progressChanges`' `raised`; `step`'s
  `wrong_answer_kind`; `buildDistractorPrompt` naming each item's task and both languages'
  writing rules; `validateDistractors` per task, including Hebrew rejected in a `word` item and
  alternatives cleaned rather than refused.
- **server services (fakes):** `prepareSession` writes types by position, in pick order, with
  alternatives on typed questions; `submitAnswer` stores a typed verdict, answers a mismatch with
  `AnswerKindMismatch`, and records progress per D6.
- **mobile:** `feedbackFor` per verdict; `practisedRows` ordering badge risers, then dimension
  risers, then the rest; the api client sends `text`.

### Integration (real Postgres)

- the migration keeps every existing question and answer, and the new checks refuse a typed
  question with options, a choice question without them, an answer with both an option and a
  text, and an unknown verdict;
- a list session prepared through the queue holds the three types in cycle order, with
  alternatives stored;
- a typed answer round-trips: stored text and verdict, rebuilt by `loadSession`, read as evidence;
- `findSnapshot` shows form and meaning for reverse and typed questions;
- the next-step route: a typed body answered 200; a mismatch 400; the completed body carries
  `raised`;
- the recompute writes back what the live path wrote for a session with all three types.

### E2E

- `question-types.spec.ts` (new): a list session of four saved senses plays a choice card, a
  reverse card, a typed card answered with a near miss (the banner shows **כמעט!** and the
  spelling) and a final choice card. The results show a dimension tag. The word's detail then shows
  `כתיבה` above טרם תורגל.
- a second test answers a typed card with **הצגת התשובה** and sees it in the missed list.
- `next-session.spec.ts` and `progress.spec.ts` play mixed sessions: they answer each card by its
  type rather than assuming four options, and progress expects the three-dimension badge.

### Eval

The new and extended distractor cases (§2). Run against the real model until they pass reliably. A
failing case changes the prompt, never the threshold.

---

## Build order

1. Core: the union, the judge, `evaluate`, `LIVE_DIMENSIONS`.
2. Server domain: the type cycle, the evidence table, `raised`, the three-task prompt and its
   validation.
3. Migration, repositories, service, route.
4. Eval cases, run against the real model.
5. Mobile: the typed card, the reverse card, the banner, the results tag.
6. Integration and e2e tests, run in CI. This worktree has no lane while all nine are taken.

## Risks

- **Badges drop once** (D7), by at most one level today. Announced in the PR.
- **Alternatives come from the model.** A wrong alternative would let a wrong word pass as
  "right, but not this word". The harm is bounded (no progress credit, and the practised word is
  shown), and the eval's no-Hebrew and not-the-answer checks catch the structural failures, not a
  wrong synonym. Watch for reports of a wrong answer accepted.
- **Inflected saved forms.** `מדבר` → `parlo` is ambiguous between `parlo`, `parla` and `parli`.
  The lemma rule credits `parlare`, and the model is asked to list the other right forms as
  alternatives, but a learner may still type a defensible form that is in neither. If this shows
  up, the remedy is asking the model for the prompt's person and number as a hint, not loosening
  the judge.
- **Typed cards on new words** may make early sessions harder. If skips rise or Victor reports
  frustration, D3 is the decision to revisit, together with spaced repetition.
