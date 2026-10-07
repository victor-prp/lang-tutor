# Phase 27 — Deeper question types

- **Status:** Victor scoped the phase in the one-pager and chose, in conversation on 2026-10-07:
  meaning recall, a gap in a new sentence and sentence translation (A + B + C); translation over
  writing one's own sentence; phase 24 Part B's `cloze_choice` folded into this phase; approach 1
  (sentences prepared with the session, open answers judged by the model while the learner
  waits); a wait over instant feedback for meaning recall; and §1's card set and two-PR split.
  He then asked for the rest of the design to be made without him ("I trust your decisions").
  Every later decision is in §1 with its reason. Those marked **(low confidence)** are the ones to
  read first.
  Part A is implemented on branch `phase-27-deeper-question-types` from
  `docs/superpowers/plans/2026-10-07-phase-27-part-a-meaning-recall.md`. Planning and building
  found these deviations:
  - `normaliseHebrew` lives in `packages/core`, not the server, because the server's rule (D3 step 2)
    and the app's banner (D12, "when the answer differs from the stored meaning") must compare the
    same way.
  - D12's two-part banner ("right" plus the stored meaning) is one title, `נכון! הפירוש השמור:`,
    with the meaning on the line below it, in the style of phase 23's `נכון! המילה שתרגלנו:`.
  - The migration is `0019_typed_meaning.sql`. It was built as `0018`; phase 26 merged first with
    `0018_photo_imports`, so Part A's was regenerated on top of it, with identical statements (D1).
  - The judge's answer schema is per type: `typed_meaning` answers `{ "verdict": "right" |
    "other_sense" | "wrong" }`, so Gemini's response schema already refuses a verdict the type does not have; Part B adds the
    translation one.
  - The eval replaced `begin` -> `לפתוח` with `begin` -> `להחל`, because "open" is not "begin" in
    the example sentence it was scored on.
  - No thinking budget was needed beyond the request's `thinkingBudget: 0`: the judge's tier 2
    scored 30/30 with thinking off.
  - The planner's rotation shifts: with no voices a fourth card of a four-pick session is now a
    meaning card (D9's fall-through), so the end-to-end specs that reached a second run were
    updated; the new `meaning-recall.spec.ts` covers the card and its failed check.
- **Date:** 2026-10-07
- **Source:** the one-pager `drafts/2026-10-07-deeper-question-types-one-pager.md` (main
  checkout). `drafts/` is gitignored, so everything this spec depends on is restated below.
- **Builds on:** phase 25 (branch `phase-25-speaking`, not yet in a PR when this was written:
  an answer judged by a model call made while the learner waits, the card's checking state,
  per-piece caps), phase 24 (#93: tiers and the planner,
  `judgeTyped` with a target, and Part B's unbuilt design for the context cards, which this phase
  absorbs), phase 23 (typed cards, `judgeTyped`, the typed task's alternatives) and phase 20
  (five dimensions per saved sense and the evidence table).
- **Branch:** `phase-27-deeper-question-types`. Phase 25 merged as PR #94, so this branch's PR
  targets `master`.
- **Touches:** the wire's `Question` union gains four members and the API one endpoint, both
  additive under ADR 0003. The judge's prompt and verdict mapping are pure domain functions
  (ADR 0001 R3), and its model call goes through the existing `LlmClient` contract (R11). No ADR
  changes, no new check script.

## Goal

After phase 25 every card tests one word on its own: recognise it, recall it, hear it, say it. A
learner can pick a meaning from four options without being able to recall it, and meets a word
only alone or in one saved example, which can be memorised. Nothing asks them to use the word in
a sentence, so a high badge can hide a word they cannot use. This phase adds four cards:

- **meaning recall** (`typed_meaning`): the word in the language being learned is shown, and the
  learner types its Hebrew meaning;
- **the missing word, picked** (`cloze_choice`): the saved example with the word blanked, and
  four words to choose from, as phase 24 designed it;
- **the missing word, typed, in a new sentence** (`cloze_typed`): a sentence written for this
  session, with the word blanked and the whole sentence in Hebrew below it. The gap may need an
  inflected form;
- **sentence translation** (`sentence_translation`): a short Hebrew sentence that uses the word's
  meaning, which the learner translates.

**Done means:**

1. With eligible saved words, list sessions use all four new cards, and two cards in a row never
   share a type (D9).
2. A `cloze_typed` sentence differs from the saved example and from the last sentence that card
   showed for the sense. A `sentence_translation` sentence differs from the last one shown for the
   sense (D8).
3. A right answer in other words is accepted: a Hebrew synonym, or another form of the meaning,
   on meaning recall; a translation unlike the reference on sentence translation (D3, D4).
4. Every new card moves at least one existing dimension (D10).
5. Each outcome above is checked by an automated test. `npm test`, `npm run test:all`,
   `npm run lint:arch`, `npm run e2e` and `npm run eval` pass. The eval has cases for the judge
   and for both new generation tasks, and `TIER2_THRESHOLD` is not lowered.
6. Victor's own use after merge decides whether words with high badges now feel usable in a
   sentence. There is no number. The `answer_judged` log (D14) gives the measured wait, so a
   report that the wait is too long can be checked against it.

## Scope

**In:**
- the four types end to end, for every target language;
- the judge: an endpoint that judges an open answer with one model call while the learner waits
  (D3, D4);
- the `gap` task (phase 24 D9) and two new generation tasks, `sentence` and `translate` (D5, D6);
- reading a sense's recent sentences so a new one differs (D8);
- the four types in the planner's tiers (D9), and their evidence (D10);
- eval cases for the judge and the three generation tasks;
- delivery as two PRs from this one spec (D1).

**Out:**
- writing one's own sentence with the word: C is translation only (one-pager);
- showing depth apart from the badge: the new cards credit the existing dimensions (one-pager);
- saying why an answer is wrong, beyond showing the right one (one-pager);
- choosing a card's type from the word's level (one-pager; phase 23 D3 stands);
- voice versions of the new cards, and translating a sentence into Hebrew (one-pager);
- a pick-from-options version of the new-sentence gap: `cloze_choice` stays on the saved example
  (one-pager);
- grammar teaching such as conjugation tables (one-pager);
- changes to the seeded first session, timed rounds, a setting to switch types off (one-pager);
- a bank of sentences per word, written in the background (approach 3, rejected in conversation;
  switch signal: `model_ms` shows preparation slowing because of sentences);
- judging on the device against a prepared list (approach 2, rejected in conversation);
- marking the practised word in the Hebrew sentence of a translation card;
- Hebrew spelling as evidence: the spelling dimension is about the language being learned
  (phase 20);
- storing or showing the judge's reasoning.

---

## 1. Decisions

**D1. One design, two PRs, stacked on phase 25.**

- **Part A, meaning recall and the judge:** `typed_meaning`, the judged-answer endpoint, the judge
  prompt for meaning recall and its eval cases. It generates nothing new at preparation, so the
  only new model risk is the judge, which gets its own review and eval run.
- **Part B, sentences:** the sentence columns, `cloze_choice` with the `gap` task, `cloze_typed`
  with the `sentence` task, `sentence_translation` with the `translate` task and the judge prompt
  for translation, and their eval cases. The generation risk sits here.

Phase 25 built the pattern both parts lean on: a model call made outside any transaction while
the card shows **בודקים…**, a 502 the card answers with **נסו שוב**, and a replay that returns the
stored verdict without a second call. Building on `master` would mean building that pattern a
second time and merging two versions of it later, so the branch is stacked on
`phase-25-speaking` and retargeted to `master` once phase 25 merges.

Phase 24's Part B is absorbed. Its `cloze_choice` design stands as written (D7). Its
`cloze_typed` is replaced by D5, because building the saved-example version first would mean
building that card twice. Migration numbers are taken at build time: phase 26 (photo import)
also claims `0017` on its branch, and whichever merges second renumbers.

**D2. Four types.**

| Type | Before the answer, the card shows | The learner | Answer | Judged by | Model task at preparation |
|---|---|---|---|---|---|
| `typed_meaning` | the form and its part of speech | types its Hebrew meaning | text | the judge (D3) | none |
| `cloze_choice` | the saved example with the word blanked, and nothing else | picks the missing word of four | option | the phone | `gap` (D7) |
| `cloze_typed` | a new sentence with a gap, and the whole sentence in Hebrew | types the missing word, in the form the sentence needs | text | the phone (D5) | `sentence` (D5) |
| `sentence_translation` | a short Hebrew sentence that uses the word's meaning | types it in the target language | text | the judge (D3) | `translate` (D6) |

**הצגת התשובה** ("show the answer") on the three typed cards submits empty text, which is wrong,
as on today's typed card. It never calls the model.

**D3. The judge is one endpoint, and its model call is made outside any transaction.**

`POST /api/sessions/{id}/judged-answer` takes `{ user_id, question_id, text }`, with `text` at
most 300 characters, and returns `{ verdict, next }`. `verdict` is a typed verdict (`exact`,
`near_miss`, `alternative`, `wrong`), and `next` is the next-step response, which the app queues
while the banner shows, as it does for a spoken answer. The service, `answerJudged`:

1. **Checks before spending.** In one read transaction it loads the session. Another learner's
   session is a 404, as an unknown one is, and a session that is not ready takes no answer. If
   the last answer is to this question, the request is a retry: the stored verdict comes back and
   the model is not called. Every answer to a judged card comes through this endpoint, so any
   stored verdict is replayable. Otherwise the question must be the current one, and of a judged
   type (`typed_meaning` or `sentence_translation`), or the request is refused as phase 25 refuses
   a stale upload. The same transaction reads the judge's context (D4).
2. **Judges without a call when it can.** Empty text is `wrong`. A `typed_meaning` answer equal
   to the stored meaning, after Hebrew normalising (NFC, points and cantillation removed,
   punctuation removed, single spaces), is `exact`. A `sentence_translation` answer equal to the
   reference translation under `normaliseTyped` is `exact`.
3. **Otherwise asks the model once,** through the existing `LlmClient`, with the judge prompt
   (D4). A third client is wired for it, with its own budget, `JUDGE_TIMEOUT_MS` (default 8 000),
   and thinking off, as phase 25's transcriber has. There is no retry: the learner's **נסו שוב**
   is the retry. A failure, or an answer the parser cannot read, logs `answer_judge_failed` and
   throws `LlmUnavailable`, which the route answers with 502.
4. **Logs** `answer_judged` (D14), and then
5. **records the answer** through `submitAnswer`, exactly as a next-step does, in one write
   transaction.

The judged verdict travels into `step` as a new kind of answer, `{ text, judged }`, which only
the server builds, as only the server builds a transcript (phase 25 D5). `evaluate` records a
judged type's verdict from it and never judges such a card itself. A next-step `text` body sent to
a judged card does not fit it and is refused (`wrong_answer_kind`). The next-step schema has no
`judged` field, so a client cannot supply one.

- **Why a separate endpoint and not next-step.** Next-step would have to load the question to
  learn whether this text costs a model call. A separate route keeps every model call in the API
  visible, mirrors `/speech`, and leaves next-step free of the network.
- **Bounded spending.** Text is accepted only for the session's current, unanswered judged card,
  from the user who owns the session, and one request makes at most one call. ADR 0005 stands:
  there is no authentication.

**D4. What the judge is asked.**

`domain/judge.ts` builds one prompt per judged type and parses `{ verdict }`. Each system
instruction carries the marker `judge the learner's answer`, so MockServer can tell the call from
the others. The verdicts are mapped onto typed verdicts, so storage, scoring and evidence need no
new verdict.

- **`typed_meaning`.** The model gets the form, lemma and part of speech, the saved Hebrew
  meaning, the saved example and its Hebrew translation, which pin the sense, and the answer.
  - `right`: means the same as the saved meaning in this sense. A synonym, another form or tense
    of it (לדבר, מדבר, דיבר), with or without a prefix such as ה or ל, and with small Hebrew
    spelling slips. → `exact`.
  - `other_sense`: a right meaning of the word, in another of its senses. → `alternative`: right,
    but not the meaning practised. The banner names the practised one.
  - `wrong`: anything else. → `wrong`.
- **`sentence_translation`.** The model gets the Hebrew sentence, the reference translation, the
  practised word (form, lemma, part of speech, Hebrew meaning) and the answer.
  - `right`: conveys the Hebrew sentence as an acceptable sentence, and uses the practised word, in
    whatever form the sentence needs, spelled correctly. Slips in other words, and small grammar
    slips that do not touch the practised word, are ignored. → `exact`.
  - `misspelled`: as `right`, but the practised word has a one-letter or accent slip. →
    `near_miss`.
  - `other_word`: conveys the sentence, but with another word in place of the practised one. →
    `alternative`.
  - `wrong`: misses the meaning, does not make sense, leaves the word out, or uses it wrongly,
    including in the wrong form. → `wrong`.
- **A wrong form is wrong. (low confidence)** On translation and on the new-sentence gap, an
  inflection error records a `written_productive` failure (D10). The phase 20 dimension is "produce
  the written word", and getting its form wrong is arguably a grammar failure instead. The cost is
  small: a wrong answer blocks that day's step and never demotes. A separate "right word, wrong
  form" verdict is the alternative, and it is the kind of explanation the one-pager put out.
  Switch signal: Victor sees words stall on `written_productive` while he knows them.
- **Thinking off. (low confidence)** It keeps the wait near phase 25's text-only measurement. If
  the judge's eval tier 2 falls short, the remedies are the prompt first, then a small thinking
  budget on the judge's client only, and never the threshold.

**D5. `cloze_typed` writes a new sentence each time.**

- **The `sentence` task.** The model gets the form, lemma and part of speech, the saved Hebrew
  meaning, the saved example and its translation as the sense, and `avoid`: the saved example and
  the sense's recent sentences on this card (D8). It returns:
  - `sentence`: in the language being learned, 3 to 12 words, everyday vocabulary;
  - `gap`: the practised word exactly as it appears in that sentence, in whatever form the
    sentence needs;
  - `translation`: the whole sentence in Hebrew, which fixes person, number and tense;
  - `alternatives`: other words that fill the gap equally well under this translation, in the
    form needed, at most five.
- **Validation** is pure (`domain/sentences.ts`). The sentence has 3 to 12 words and no Hebrew
  letters. The gap occurs exactly once as whole words (`findGap`, D7), and has as many words as
  the saved form, so a compound tense such as `abbiamo parlato` is never a one-word form's gap. The
  translation has Hebrew letters. The sentence equals no `avoid` entry under `normaliseTyped`. The
  alternatives are cleaned as the typed task's are.
- **An invalid item degrades the card instead of failing the session.** The position becomes
  `typed_translation` with no alternatives, and `sentence_degraded` is logged with the type and the
  reason. A choice task's failure leaves no usable card, so it fails the attempt, but a failed
  sentence leaves one. At temperature 0 a retry also tends to reproduce the same answer.
- **Judging** is `judgeTyped` with the target `{ answer: gap, lemma: gap, alternatives }`. The
  saved form and its lemma are wrong unless the sentence needs them: phase 23's "`parlare` is
  right for a saved `parlo`" holds only for a word on its own.
- **The card** shows the sentence with its gap, left to right, and the Hebrew translation, right
  to left, below it. After the answer the gap is filled, and the sentence gets its speaker, as
  phase 24 D9 has it.
- **The sense.** The prompt asks for the saved meaning, and nothing at run time can check that it
  was used. The eval does (§3).

**D6. `sentence_translation`.**

- **The `translate` task.** The model gets the same context as `sentence`, and `avoid`: the
  sense's recent Hebrew sentences on this card (D8). It returns:
  - `sentence`: Hebrew, 3 to 10 words, natural and everyday, using the saved meaning;
  - `translation`: a natural translation in the language being learned that uses the practised
    word;
  - `gap`: the practised word as it appears in that translation.
- **Validation.** The Hebrew sentence has 3 to 10 words, Hebrew letters and none of the target
  language's script. The translation is in the target script, and the gap occurs in it exactly
  once as whole words, with as many words as the saved form. The Hebrew sentence equals no `avoid`
  entry. An invalid item degrades to `typed_translation`, as in D5.
- **Stored** in the same columns as a gap card, read the other way round: `sentence` is the
  reference translation, `sentence_translation` the Hebrew sentence, and the gap offsets mark the
  word in the reference.
- **The card** shows the Hebrew sentence and a multi-line input, left to right. After the answer it
  shows the reference with the practised word in bold, with its speaker.

**D7. `cloze_choice` is phase 24's design.** Phase 24 D8 (the saved form's own example, the gap
finder, coverage, the stored sentence and offsets), D9's first bullet (the sentence alone before
the answer, and the `gap` task's three wrong words of the same part of speech and form that make
the sentence wrong), D12's `cloze_choice` rows and D14's row all stand. `findGap(sentence,
candidates)` lives in `domain/cloze.ts` and is shared with D5 and D6.

**D8. "Not the last one shown" reads what was prepared.**
`question.findRecentSentences({ enrollmentId, senseIds, limit: 3 })` returns, per sense and newest
first, the `sentence` of the enrollment's `cloze_typed` questions and the `sentence_translation`
of its `sentence_translation` questions. A prepared question counts as shown, even when its
session was skipped. That is cheap and errs towards variety. The saved example is always in
`cloze_typed`'s `avoid` list. Validation refuses a sentence equal to any `avoid` entry, so Done
means 2 holds by construction rather than by the prompt alone.

**D9. Eligibility and tiers.**

| Tier | Types, in rotation order |
|---|---|
| recognise | `multiple_choice`, `listen_choice`, `read_aloud`, `typed_meaning` |
| pick the form | `reverse_choice`, `cloze_choice`, `letter_tiles` |
| produce | `typed_translation`, `cloze_typed`, `dictation`, `say_translation`, `sentence_translation` |

- **Meaning recall opens a run.** It is about meaning, which is the recognise tier's dimension,
  and is recall, the hardest card there, so it is appended last.
- **The cloze types go at index 1,** where phase 24 planned them. **Translation is appended to
  produce:** it closes a run, as the deepest production.
- **Eligibility is decided before the model is called** (phase 24 D4). `typed_meaning` is always
  eligible. `cloze_choice` needs a gap in the saved example (phase 24 D4). `cloze_typed` and
  `sentence_translation` need a form of at most four words, phase 25's rule for speaking, through
  the same predicate. A saved sentence cannot be gapped into a new sentence or translated as a
  word.
- **Frequency.** With every type eligible, a ten-word session has two single-card runs, so meaning
  recall appears in two sessions of every four, and `cloze_typed` and translation each in two of
  every five.
- **Two cards in a row still never share a type,** since consecutive single cards sit in
  different tiers. Part A appends only `typed_meaning`, and Part B inserts the rest.
- **The rotation shifts** for sessions after the first. E2e specs that predict a later session's
  types are updated with it.

**D10. Evidence.** This continues phase 20's table, phase 23 D6, phase 24 D12 and phase 25 D10
under their rules.

| Type | Verdict | `written_receptive` | `written_productive` | `spelling` |
|---|---|---|---|---|
| `typed_meaning` | `exact` | ✓ | — | — |
| `typed_meaning` | `alternative` | — | — | — |
| `typed_meaning` | `wrong` | ✗ | — | — |
| `cloze_choice` | as phase 24 D12 | | | |
| `cloze_typed` | as `typed_translation` | | | |
| `sentence_translation` | as `typed_translation` | | | |

Meaning recall is uncapped: recalling a meaning is stronger evidence than picking it from four,
which phase 20 already credits uncapped. It credits no spelling, because the answer is Hebrew. No
dimension goes live, so badges do not recalibrate.

**D11. Wire.**

- `TypedMeaningQuestion`: `id`, `type`, `vocab_term_id`, `question` (the form), `part_of_speech`,
  `meaning` (shown after the answer).
- `ClozeChoiceQuestion`: phase 24's, with `sentence`, `gap: { start, end }`, `translation`,
  `meaning`, `options` and `correct_option`.
- `ClozeTypedQuestion`: `sentence`, `gap`, `translation`, `meaning`, `answer` (the gap's text) and
  `alternatives`.
- `SentenceTranslationQuestion`: `question` (the Hebrew sentence), `meaning`, `sentence` (the
  reference), `gap` (the word in it) and `answer` (the word as written there).
- `JudgedAnswerRequest` `{ user_id, question_id, text ≤ 300 }`, and `JudgedAnswerResponse`
  `{ verdict, next }`.
- The next-step `text` body stays at most 100 characters. `answers_typed_text_length` rises to
  300, in Part A's migration, so that one rule covers both judged types.

**D12. Text on the cards.**

| Type | Instruction | Banner |
|---|---|---|
| `typed_meaning` | **כתבו את הפירוש בעברית** | `exact`: **נכון!**, and when the answer differs from the stored meaning, **הפירוש השמור:** the meaning. `alternative`: **נכון, אבל כאן תרגלנו:** the meaning. `wrong`: **התשובה הנכונה:** the meaning |
| `cloze_typed` | **השלימו את המילה החסרה ב**language | phase 23's typed banners, with the gap's word |
| `sentence_translation` | **תרגמו ל**language | `exact`: **נכון!** `near_miss`: phase 23's **כמעט! כך כותבים:** the word. `alternative`: **נכון! המילה שתרגלנו:** the word. `wrong`: nothing more. Every verdict then shows **תרגום לדוגמה:** the reference |
| `cloze_choice` | phase 24 D14 | phase 24 D14 |

While the judge works, the button reads **בודקים…** and is disabled. A failed check shows
**לא הצלחנו לבדוק** and **נסו שוב**, keeping the typed text. The language name comes from the
active enrollment, as in phase 23 D9.

**D13. The app.**

- **Direction.** `typed_meaning`'s input is right to left, the first typed Hebrew answer in a
  card. Every other input stays left to right. `TypedAnswerView` takes the direction.
- **Waiting.** For a judged card the app sends the answer to the judged-answer endpoint and shows
  the banner from the verdict that comes back. It never judges the card itself, and it queues
  `next` as it does for a spoken answer. The request aborts after 15 seconds, as phase 25's speech
  upload does, which shows the "couldn't check" notice.
- **The other new cards** are judged on the phone, as today's typed card is.

**D14. Measured.**

- `answer_judged`: `session_id`, `question_type`, `verdict`, `judged_by` (`rule` or `model`), and
  `judge_ms` when the model was called. It is logged before the answer is recorded, so a paid call
  is always logged.
- `answer_judge_failed`: `session_id`, `question_type`, `judge_ms` and `reason`.
- `sentence_degraded`: `session_id`, `type` and `reason` (D5).
- `session_prepared` already carries `model_ms` and `item_count`, which show whether sentences make
  preparation slower.

**D15. Every new type keeps the saved meaning in `questions.prompt`,** as phase 24 D15 has it, so
`findSnapshot` and the missed list show form → meaning for all four.

---

## 2. Changes

### Part A

**`packages/core`**
- `api/schemas.ts`: `TypedMeaningQuestionSchema` in the union; `JudgedAnswerRequestSchema` and
  `JudgedAnswerResponseSchema`; `LlmJudgeSchema` `{ verdict: string }`, the model's answer, mapped
  and refused in the server.
- `domain/quiz.ts`: `isJudged(question)`. `AnswerInput` gains `{ text, judged }`. `answerFits`
  makes a judged card take only that. `evaluate` records its verdict. `rightAnswer` and `missed`
  cover the new type.
- `domain/progress.ts` (core): nothing; no dimension goes live.

**Server**
- **Migration (Part A).** `questions_type_known` admits `typed_meaning`, and `questions_shape_valid`
  gives it a prompt and no options, alternatives or tiles. `answers_typed_text_length` rises to 300.
- `domain/plan.ts`: `typed_meaning` appended to the recognise tier, always eligible.
- `domain/judge.ts` (new): `normaliseHebrew`, `meaningRuleVerdict` (D3 step 2), `buildMeaningJudgePrompt`,
  `parseMeaningJudge` and the mapping of D4. All pure.
- `domain/progress.ts`: `evidenceFor` for `typed_meaning` (D10), and the text-answer types.
- `domain/distractors.ts`: `typed_meaning` asks the model nothing at preparation.
- `repo/questions.ts`: `questionFrom` builds the new shape. `findJudgeContext(questionId)` reads
  the form, lemma, part of speech, stored meaning, and the saved example and its translation.
- `repo/progress.ts`: the new type among the text types.
- `services/sessions.ts`: `answerJudged` (D3), with `judge: LlmClient` among the service's deps.
- `routes/sessions.ts`: the judged-answer route, with 404, 409, 422 and 502 as `/speech` maps
  them.
- `config.ts`: `judgeTimeoutMs` from `JUDGE_TIMEOUT_MS`, default 8 000.
- `providers/gemini.ts`: `createGeminiClient` takes an optional `thinkingBudget`, which only the
  judge's client sets, to 0.
- `composition.ts`: the judge client.

**Mobile**
- `components/TypedAnswerView.tsx`: takes the input's direction, and a pending state for the
  check.
- `api` client: `judgeAnswer`.
- `hooks/useSession.tsx`: `submitJudged(text)`: sends, waits, sets the answer with the server's
  verdict, queues `next`, and surfaces a failure to retry.
- `feedback.ts`: `feedbackFor` takes the stored verdict for a judged card.
- `app/session.tsx`: the new case in the exhaustive switch.
- `strings.ts`: D12's instruction and banners.

**Eval (Part A)**
- `JUDGE_CASES`: meaning recall per target language. Each case has the word, the meaning, the
  example, an answer and the expected verdict: synonyms, another form or tense, a prefix, a Hebrew
  typo, another sense, and wrong meanings.
- Tier 1: the answer parses to a known verdict. Tier 2: the verdict is the expected one, scored
  as `judge tier 2` against `TIER2_THRESHOLD`.

### Part B

**`packages/core`**
- `api/schemas.ts`: `ClozeChoiceQuestionSchema`, `ClozeTypedQuestionSchema` and
  `SentenceTranslationQuestionSchema` in the union. `LlmDistractorsSchema`'s items gain optional
  `sentence`, `gap` and `translation`.
- `domain/quiz.ts`: `isChoice` covers `cloze_choice`, and `isJudged` covers
  `sentence_translation`. `cloze_typed` is judged by `judgeTyped` with D5's target.

**Server**
- **Migration (Part B).** `questions.sentence`, `sentence_translation`, `gap_start` and `gap_end`.
  The type check admits the three types: `cloze_choice` has options, a prompt and the four sentence
  columns; `cloze_typed` has a prompt, alternatives and the four; `sentence_translation` has a
  prompt and the four. The four are null for every other type, and `0 <= gap_start < gap_end`.
- `domain/cloze.ts` (new): `findGap(sentence, candidates)`.
- `domain/sentences.ts` (new): `validateSentenceItem` and `validateTranslateItem` (D5, D6).
- `domain/distractors.ts`: the `gap`, `sentence` and `translate` tasks in `Task`, `taskFor` and the
  prompt. Items carry the example, its translation and `avoid`. `generatedContent` builds the
  three shapes, and degrades an invalid sentence item (D5).
- `domain/plan.ts`: the three types in their tiers, with their eligibility.
- `domain/judge.ts`: the translation prompt.
- `domain/progress.ts`: evidence for the three (D10).
- `repo/questions.ts`: `findGenerationContext` also reads the example and its translation.
  `findRecentSentences` (D8). `questionFrom` and `insertGeneratedQuestions` cover the sentence
  columns.
- `services/sessions.ts`: `prepareSession` reads the recent sentences, finds the gaps, and logs
  `sentence_degraded`.

**Mobile**
- `components/SentenceGap.tsx` (new): a sentence with its gap, left to right, filled after the
  answer.
- `cloze_choice` reuses `MultipleChoiceView` with the sentence as its prompt. `cloze_typed` reuses
  `TypedAnswerView` with the sentence and its translation. `sentence_translation` reuses it, with a
  multi-line input and the reference after the answer.
- `feedback.ts`, `app/session.tsx` and `strings.ts` cover the three.

**Eval (Part B)**
- `gap` cases, as phase 24 §2 lists them.
- `sentence` and `translate` cases per target language, including words with several senses
  (`book` as להזמין, `run` as לנהל), each listing `off_sense` words that would show the wrong sense,
  and an `avoid` sentence. Tier 1: the item passes D5's or D6's validation. Tier 2: no `off_sense`
  word appears, scored with the distractor cases.
- Judge cases for translation: a paraphrase unlike the reference, a misspelled word, another word
  in its place, a wrong form, a missed meaning, and a sentence that makes no sense.

---

## 3. Testing

### Unit
- **core:** the union parses every new shape. `answerFits` gives a judged card only `{ text,
  judged }`, and `evaluate` records its verdict. `rightAnswer` covers each new type. `judgeTyped`
  with D5's target refuses the lemma of an inflected gap.
- **server domain:** `normaliseHebrew` and `meaningRuleVerdict` (points, punctuation, an exact match, and
  empty text); both judge prompts carry the marker and the context; `parseMeaningJudge` maps every
  verdict and refuses an unknown one. The planner places each type in its tier, with the rotation
  and eligibility of D9, and never puts two of a type in a row over sizes 1 to 10. `evidenceFor`
  covers every row of D10. `findGap`. Both item validators: a gap with too many words, a sentence
  in `avoid`, the wrong script, too many words. A degraded item becomes `typed_translation`.
- **server services (fakes):** `answerJudged` checks the question before calling the model,
  replays a recorded answer without a call, rules without a call (empty text, an exact match),
  calls once otherwise, records the mapped verdict, maps a model failure to `LlmUnavailable` and
  records nothing, and logs `answer_judged` and `answer_judge_failed`. `prepareSession` passes the
  recent sentences as `avoid`, degrades an invalid sentence item and logs it.
- **mobile:** `feedbackFor` for each type, with the server's verdict on judged cards; the judged
  submit's waiting, success and failure paths.

### Integration (real Postgres)
- The migrations keep every existing row, and each shape check refuses a row of the wrong shape.
- `findJudgeContext` reads the saved example. `findRecentSentences` returns the enrollment's
  sentences, newest first, per sense and per type.
- A judged answer round-trips: the route with MockServer answering the judge, the stored verdict,
  the replay, and a 502 that records nothing.
- A list session prepared through the queue holds the planned new types, with sentences stored.

### E2E
- **Part A:** a list session with a meaning-recall card, answered with a synonym that MockServer
  judges right, shows **נכון!** and **הפירוש השמור:**. Specs that predict a later session's types
  follow the shifted rotation.
- **Part B:** a session with the three sentence cards. The choice card shows no Hebrew before the
  answer. The typed gap refuses the lemma of an inflected gap. A translation judged right shows
  the reference.

### Eval
The cases of §2, run against the real model until they pass reliably. A failing case changes the
prompt, never the threshold.

---

## Build order

**Part A (PR 1):**
1. Core: the union member, the judged answer kind, the request and response schemas.
2. Server domain: the judge (pure), the tier, the evidence.
3. Migration, repositories, the judge client and config, the service, the route.
4. Mobile: the right-to-left input, the judged submit, the card, the banners.
5. Eval: meaning-recall judge cases, run against the real model.
6. Integration and e2e.

**Part B (PR 2):** `findGap`, the item validators, the three tasks and their eval cases run against
the real model; the migration; the three cards; the translation judge and its cases; tests.

## Risks

- **The wait.** Every judged answer that does not match exactly waits for a model call. Phase 25
  measured about 1.7–2.0 s for audio, and text should be faster. `answer_judged.judge_ms` measures
  it. If it is too slow, the remedy is a smaller prompt or a faster model for the judge, never
  judging on the device (approach 2).
- **A lenient or strict judge.** The eval scores both directions: right answers in other words,
  and wrong ones. Watch for reports of an unfair verdict.
- **A sentence in the wrong sense.** Nothing at run time checks the sense. The eval's `off_sense`
  cases catch the common confusions, and Victor's use catches the rest.
- **Wrong forms count wrong** (D4). Switch signal in D4.
- **Preparation gets slower.** Sentences lengthen the answer, and answer length dominates a call's
  time (phase 24 D16). `model_ms` and `item_count` show it, and the sentence bank is the remedy if
  it matters.
- **Degraded cards.** A sentence item that keeps failing validation leaves the learner with a
  plain typed card. `sentence_degraded` counts it.
- **The phase 25 base moves.** Until phase 25 merges, this branch is rebased on it when it
  changes.
