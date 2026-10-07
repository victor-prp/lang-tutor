# Phase 24 — Listening, context and variety cards

- **Status:** Designed autonomously on 2026-10-07. Victor scoped the phase in the one-pager, then
  asked for the design to be made without questions ("Do brainstorming with yourself. I trust
  your judgement") and for the low-confidence decisions to be listed for review. Every decision is
  in §1 with its reason, so each one can be overturned in review. Those marked
  **(low confidence)** are the ones to read first. Part A (D1–D7, D10–D16) is implemented on
  branch `phase-24-more-question-types` from the plan
  `docs/superpowers/plans/2026-10-07-phase-24-listening-variety.md`. Part B (the context cards:
  D8, D9, the `gap` task) is not yet planned. Planning and building found these deviations:
  - The planner lives in `domain/plan.ts`, not `domain/session.ts`.
  - Part A's tiers hold only the types that exist: recognise `multiple_choice, listen_choice`;
    pick the form `reverse_choice, letter_tiles`; produce `typed_translation, dictation`. Part B
    inserts the cloze types at index 1 of the second and third.
  - `withBoards` lives in `repo/questions.ts` beside `questionFrom` (ADR 0001 R4 lets
    persistence import domain types only), and `shuffleSession` in core beside `shuffleOptions`.
  - The e2e plays every Part A type in one ten-word session at ordinal 0, and checks
    `הבנת הנשמע` on the results screen rather than on the word's page. The ordinal-1 rotation is
    covered by unit tests.
  - An old prepare-session payload is tested at unit level.
  - Making `spoken_receptive` live required updating several existing tests whose fixtures had
    treated both spoken dimensions as not live: server vocabulary unit, integration and route
    tests, and the progress e2e.
- **Date:** 2026-10-07
- **Source:** the one-pager `drafts/2026-10-07-more-question-types-one-pager.md`. `drafts/` is
  gitignored, so everything this spec depends on is restated below.
- **Builds on:** phase 23 (#89: reverse choice, typed translation, `judgeTyped`, the type cycle;
  #90: device speech, `SpeakButton`, `canSpeak`), phase 20 (five dimensions per saved sense,
  `LIVE_DIMENSIONS`, the evidence table in its §3) and phase 19 (list sessions, the
  prepare-session job, one model call per session).
- **Touches:** the wire's `Question` union gains six members and `CreateSessionRequest` one
  field, both additive under ADR 0003. The planner and the tile shuffle are pure domain functions
  under ADR 0001 R3. No ADR changes, no new check script.

## Goal

A learner meets a word only as written text, and alone. They may read it yet not know it when
they hear it, so `spoken_receptive` never leaves "not practised" for anyone. They never see it
inside a sentence. And three card types still make sessions feel samey. This phase adds six
cards:

- **listening:** hear the word and pick its meaning, and dictation;
- **context:** a sentence with the word blanked, either picking the word or typing it;
- **variety:** a matching board, and letter tiles.

**Done means:**

1. With listening available and eligible words, list sessions use all nine card types. A
   ten-word session holds one matching board and six single cards of six different types. Two
   cards in a row never share a type, and three sessions in a row show every eligible type (D3).
2. A correct listening answer moves `spoken_receptive` above "not practised", and the badge
   averages it with the three written dimensions (D13).
3. A gap card's sentence is the saved form's own example for the saved sense, so it uses the word
   in its saved meaning (D8).
4. Every new card yields evidence for at least one dimension (D12). None is variety only.
5. Each outcome above is checked by an automated test. `npm test`, `npm run test:all`,
   `npm run lint:arch`, `npm run e2e` and `npm run eval` pass. The eval has cases for the new
   generation task, and `TIER2_THRESHOLD` is not lowered.
6. Victor's own use after merge says whether sessions feel less samey. That is the acceptance for
   engagement, which nothing in the app counts.

## Scope

**In:**
- `listen_choice`, `dictation`, `matching`, `letter_tiles`, `cloze_choice` and `cloze_typed`,
  end to end, for every target language;
- the planner that gives each position of a list session its type;
- `spoken_receptive` going live;
- one new generation task, `gap`, with eval cases;
- a five-minute cap on the generation call, with the job's expiry raised to match (D16);
- delivery as two PRs from this one spec (D1).

**Out:**
- speaking (`spoken_productive`);
- timed rounds;
- counting engagement: session length, completion rate;
- changes to the seeded first session, which stays today's card only;
- a setting to choose or switch off types, including a "can't listen now" switch (D6);
- typed meaning recall, target → Hebrew;
- choosing a card's type from the word's level (phase 23 D3 stands);
- new example sentences: a word with no usable example gets no gap card (D8);
- conjugation: a gap is only ever the saved form or its lemma (D8);
- an in-app announcement of the badge recalibration (D13, as phase 23 D7).

---

## 1. Decisions

**D1. One design, two PRs, context second. (low confidence)** This answers the one-pager's open
question.

- **Part A, listening and variety:** `listen_choice`, `dictation`, `matching`, `letter_tiles`, the
  planner and `spoken_receptive` going live. It changes no prompt: the only task it sends the
  model is `meaning`, which exists. It ships on tests alone.
- **Part B, context:** `cloze_choice`, `cloze_typed`, the gap finder, the `gap` task with its eval
  cases, and the sentence columns. The model risk sits here, so it gets its own review and its
  own eval run.

The planner (D3) is built once in Part A with Part B's types in its tiers, ineligible until Part
B makes them eligible. As one PR this would be about three times phase 23's question-types PR.
Two specs were rejected because the tiers, the evidence table and the wire union are one design.

**D2. Six new types, each answered by one of phase 23's two answer kinds.**

| Type | Before the answer, the card shows | The learner | Answer | Model task |
|---|---|---|---|---|
| `listen_choice` | a play button; the word is spoken, never shown | picks its Hebrew meaning of four | option | `meaning` |
| `dictation` | a play button | types the word | text | none |
| `matching` | four words and five Hebrew meanings | pairs them | an option per word | `meaning`, for one word (D10) |
| `letter_tiles` | the Hebrew meaning, its part of speech, the tiles | builds the word | text | none |
| `cloze_choice` | the example sentence with the word blanked | picks the missing word of four | option | `gap` (new, D9) |
| `cloze_typed` | the sentence with the gap, the Hebrew meaning and part of speech | types the missing word | text | `typed` |

`NextStepRequest`, the `answers` table and the session's `step` keep their shapes, because a
board's words are answered one by one (D10). A new type is therefore a new union member, a new
case in each exhaustive switch, and nothing else structural.

**D3. Types come from three tiers, rotating by session, not drawn at random. (low confidence on
the rotation and on the board's fixed place)** Phase 23 D2's run of three, which climbs from
recognition to recall, generalises to tiers:

| Tier | Types, in rotation order | Always eligible |
|---|---|---|
| recognise | `multiple_choice`, `listen_choice` | `multiple_choice` |
| pick the form | `reverse_choice`, `cloze_choice`, `letter_tiles` | `reverse_choice` |
| produce | `typed_translation`, `cloze_typed`, `dictation` | `typed_translation` |

A session of `n` picks, in pick order (already random, `pickSenses`), is laid out as follows:

- **`n ≥ 7`:** a run of three, then the matching board (four picks, D10), then runs of three over
  the rest. Ten words is 3 + board + 3.
- **`n < 7`, or no four picks can make a board:** runs of three, as in phase 23.

Position `i` of a run gets tier `i`. Within a tier, the preferred type is
`tier[(k + r) mod size]`, where `k` is the number of list sessions the enrollment had before this
one and `r` is the run's index in this session. When the pick is not eligible for that type (D4),
the next type in the tier's order is tried, ending at the always-eligible one.

- **Two cards in a row always differ.** Consecutive single cards sit in different tiers, and the
  board sits between a produce card and a recognise card.
- **Every type appears.** A ten-word session of eligible words has six single cards of six
  different types, and three sessions in a row show every type of every tier.
- **The plan is a pure function** of the picks, their eligibility, `k` and the listening flag,
  with no randomness. So an e2e test knows each position's type without a seeded rng, as phase
  23's did.

Two alternatives were rejected:

- **A random eligible type per slot.** It allows streaks (three sessions with no listening), and
  e2e could not predict it.
- **A type per word from its level.** Phase 23 D3 keeps this out until spaced repetition.

**D4. Eligibility is decided before the model is called.**

- **`listen_choice`, `dictation`:** the session was created with listening on (D5).
- **`letter_tiles`:** the form, with stress marks removed, is one word of 3 to 10 letters and
  nothing else. A phrase or an elision (`l'acqua`) has no sensible tile set, and a long word is a
  wall of tiles.
- **`cloze_choice`, `cloze_typed`:** the gap finder (D8) finds a gap in the saved form's example.
- **`matching`:** D10.

The job makes one model call and one write. If a type proved ineligible after the call, its
content would have been generated for the wrong task.

**D5. The listening flag comes from the app.** Only the device knows whether it has a voice for
the target (phase 23 voice, D5). `CreateSessionRequest` gains `listening: boolean`, optional and
false when absent, and the app sends `canSpeak(target)`. The flag travels in the prepare-session
payload, also defaulting to false, so a job enqueued before the deploy prepares a session without
listening cards.

- **A device with no voice** still gets every other type.
- **On the web, voices load after the first render.** A session started before they arrive has
  no listening cards. Accepted.

**D6. A listening card plays on arrival, and there is no "can't listen now". (low confidence)**

- **Auto-play.** The card speaks its word once when it appears, and a large play button repeats
  it. Phase 23's voice spec kept auto-play out for content, where sound is optional. On a
  listening card the sound is the question, and a tap before each one is friction with no
  purpose. The tap that advanced to the card is the user gesture a browser asks for.
- **No text until the answer.** Then the word appears with its own speaker.
- **No "can't listen now".** A learner who cannot listen (a bus, no headphones) answers the card
  anyway or skips the session. Duolingo's switch is the obvious remedy, but the one-pager put
  switching types off out of scope. Switch signal: Victor reports skipping sessions for this
  reason.
- **A device without a voice.** A listening card shown on one, as when a session is resumed on
  another device, shows the word in writing with a line saying so. The answer still counts as
  listening. That inaccuracy is accepted for a case that needs two devices.

**D7. Dictation is judged against the spoken form alone.** It uses `judgeTyped`'s normalising
and near-miss rules with a narrower target:

- **exact:** the spoken form. Not the lemma, because a learner who heard `parlo` and typed
  `parlare` wrote another word. Not an alternative, because a synonym is not what was said.
- **near miss:** only diacritics differ, or one edit on a word of five letters or more, as in
  phase 23 D5.
- **wrong:** anything else.

After the answer the card shows the word and its Hebrew meaning, so a dictation also teaches what
was heard. Evidence follows phase 20's table: full `spoken_receptive` credit, and `spelling` from
an exact answer.

**D8. A gap card uses the saved form's own example, and the gap is the form or its lemma.**

- **The sentence** is `dict_var_translations.example_source` of the saved variant and sense in
  the enrollment's source language, and `example_target` is its Hebrew translation. Every saved
  sense has one today (87 of 87 locally). It was written for that sense of that form, which meets
  Done means 3 by construction. No sentence is generated.
- **The gap finder** takes the first of the form and the lemma that occurs in the sentence exactly
  once as whole words, ignoring case. Unicode letters count as word characters, and a multi-word
  form matches as a sequence. If neither occurs, or one occurs twice, the word gets no gap card.
- **Coverage. (low confidence)** In the local database, the form occurs in 35 of 42 English
  examples, 19 of 21 Italian and 17 of 24 Russian. The misses are inflected (`dazzled`,
  `ложкой`, `летит`) or split phrasal verbs (`turns me on`). Blanking an inflected occurrence
  would need the model to name the span. The card would then test an inflection the learner never
  saved, which is conjugation, and conjugation is out. Revisit if Russian learners rarely see a
  gap card.
- **The same sentence returns** each time a word gets a gap card. Fresh sentences belong to a
  later phase.
- **The question stores the sentence**, its translation and the gap's offsets, as phase 23 D4
  stores the prompt: a repair may rewrite the example, and a question records what was asked.
  Offsets are JavaScript string indices, computed in TypeScript and never in SQL.

**D9. The two context cards. (low confidence on what each shows before the answer)**

- **`cloze_choice` shows the sentence and nothing else**, left to right, with four target words
  as options. With no Hebrew before the answer, the sentence is the only clue, and using it is
  the deeper skill this card exists for. So no wrong option may fit the sentence. Phase 23's `word`
  task does not promise that: `I want to ___ a table` admits both `book` and `clean`. The new
  `gap` task therefore asks for three wrong words of the same part of speech and form that make
  this sentence wrong or meaningless. After the answer the card shows the full sentence, with its
  speaker and its Hebrew translation.
- **`cloze_typed` shows the sentence with the gap**, and under it the word's Hebrew meaning and
  part of speech: the typed card's prompt. Without that hint, a typed gap has many right answers.
  The answer is judged exactly as `typed_translation`, by `judgeTyped` with the form, the lemma
  and the alternatives from the `typed` task. The gap is the form or the lemma (D8), so phase 23's
  judge is already right.

**D10. The matching board.**

- **Words.** The board takes four picks in pick order after the first run. Each must differ in
  form and in Hebrew meaning from the others taken. Two senses of one word, or two words with one
  meaning, would each make two pairings right. If four cannot be found, there is no board.
- **Five meanings.** The board shows the four words' meanings plus one wrong meaning, so the last
  pair is never forced. A forced match cannot be wrong, so crediting it would be credit for
  nothing. The extra is the first of the first board word's `meaning` distractors that differs
  from all four meanings, so no new task is needed. If all three collide, the attempt fails and
  pg-boss retries it, like any invalid generation.
- **Storage.** A board is four ordinary choice questions, one per word. Each has the same five
  options in the same canonical order, with `is_correct` on its own meaning, and `session_questions`
  gives all four one shared shuffle. Each word is therefore a row with one sense and one answer,
  and scoring, evidence, `step` and the missed list need no notion of a board.
- **Wire.** Each matching question carries `board`: the question ids, words and correct options of
  all four. The app draws the board from the first unanswered one. Words answered before a resume
  are shown already matched.
- **Play.** The learner taps a word and a meaning, in either order. A right pair locks. A wrong
  pair flashes and releases, and that word's first attempt is recorded as wrong. A wrong pairing
  is charged to the word: it shows the learner did not know that word's meaning, not that they
  did not know the other one.
- **Submission.** When the fourth word is matched, the app sends the four answers in order, each
  word's first-tried meaning as its option index. The banner reads **בניסיון הראשון: N מתוך 4**.
- **Evidence. (low confidence)** Each word's first attempt gives `written_receptive` evidence,
  uncapped as on today's card. Elimination makes later pairs easier. The fifth meaning and the
  step rule's spacing are the discount, as they are for four-option choice (phase 20).
- **Placement. (low confidence)** Every session of seven words or more has one board, after the
  first run: the run warms up, and the board is a change of pace mid-session.

**D11. Letter tiles.**

- **The tiles** are the form's letters, lowercased and with stress removed, plus two extra letters
  from the language's alphabet, shuffled. They are chosen when the session is prepared and stored
  on the question. A pure `tilesFor(form, alphabet, rng)` makes them, with the service passing its
  rng (ADR 0001 R3).
- **Play.** Tapping a tile appends it, and tapping a placed tile returns it. **בדיקה** submits the
  built word and is enabled once a tile is placed. **הצגת התשובה** submits nothing, which is wrong,
  as on the typed card.
- **Judging.** Exact or wrong: the built word against the form, normalised. A slip of the finger
  cannot happen with tiles, so a wrong order is wrong.
- **Evidence.** `written_productive` capped at 3, because the letters are given. That is
  recognition-supported production, like reverse choice. A correct answer also credits
  `written_receptive` downward. There is no spelling evidence, which phase 20 credits only for
  strict typed answers.

**D12. Evidence for the new types.** This continues phase 20's §3 table and phase 23 D6 under
their rules. Productive success credits receptive at full weight, only successes are credited
downward, recognition-format evidence caps a productive dimension at 3, and nothing crosses
modalities.

| Type | Verdict | `written_receptive` | `written_productive` | `spoken_receptive` | `spelling` |
|---|---|---|---|---|---|
| `listen_choice` | correct / wrong | — | — | ✓ / ✗ | — |
| `dictation` | exact | — | — | ✓ | ✓ |
| `dictation` | near miss | — | — | ✓ | ✗ |
| `dictation` | wrong | — | — | ✗ | — |
| `matching` | correct / wrong (first attempt) | ✓ / ✗ | — | — | — |
| `letter_tiles` | exact | ✓ | ✓ capped at 3 | — | — |
| `letter_tiles` | wrong | — | ✗ | — | — |
| `cloze_choice` | correct | ✓ | ✓ capped at 3 | — | — |
| `cloze_choice` | wrong | — | ✗ | — | — |
| `cloze_typed` | every verdict | as `typed_translation` | | | |

A wrong dictation says nothing about spelling, just as a wrong typed answer does not.

**D13. `spoken_receptive` goes live, and badges recalibrate once. (low confidence)**
`LIVE_DIMENSIONS` becomes `written_receptive`, `written_productive`, `spelling`,
`spoken_receptive`. Phase 20 made the badge the mean over live dimensions and accepted in advance
that a dimension going live drops badges once. Phase 23 D7 did the same.

- **The drop is at most one level.** A word at (3, 3, 2) reads 3 today and (3, 3, 2, 1) reads 2.
- **A device with no voice** cannot raise the dimension, so a learner on one tops out at a badge
  of 4. All three targets have voices on iOS and Android out of the box, so this is the case of a
  missing voice.
- **Announced in the PR**, as phase 23's recalibration was.

Rejected: keeping it out of the badge and showing it only on the word's page. That makes listening
practice invisible on the list, the problem phase 23 D7 named.

**D14. Instructions and feedback.**

| Type | Instruction | Banner when wrong, or when not exact |
|---|---|---|
| `listen_choice` | **הקשיבו ובחרו את הפירוש** | **התשובה הנכונה:** the meaning |
| `dictation` | **הקשיבו וכתבו באיטלקית** | phase 23's typed banners, with the form |
| `matching` | **התאימו כל מילה לפירוש שלה** | **בניסיון הראשון: N מתוך 4**; correct colours only at 4 of 4 |
| `letter_tiles` | **הרכיבו את המילה באיטלקית** | **התשובה הנכונה:** the form |
| `cloze_choice` | **איזו מילה חסרה?** | **התשובה הנכונה:** the form |
| `cloze_typed` | **השלימו את המילה החסרה באיטלקית** | phase 23's typed banners |

The language name comes from the active enrollment, as in phase 23 D9. Results need no new
mechanism. `raised` names **הבנת הנשמע** from the existing `DIMENSION_NAMES`. A missed row reads
word → meaning for every type (`missedPair`, extended). Every target-language word on a results
row already has a speaker (phase 23 voice, D3).

**D15. Where each card keeps its Hebrew meaning.** A type whose options are Hebrew
(`multiple_choice`, `listen_choice`, `matching`) keeps the meaning as its correct option. Every
other type stores it in `questions.prompt`, including `dictation` and `cloze_choice`, which show
it only after the answer. `findSnapshot` reads it from there, so the results always show
form → meaning.

**D16. Generation gets a five-minute budget, and the job's expiry follows it.** Victor reports
that preparing a session is already slow, and asked on 2026-10-07 for a longer timeout with the
model capped at five minutes.

- **The cap.** `SESSION_GENERATION_TIMEOUT_MS` defaults to 300 000 instead of 120 000. At the
  budget the provider aborts, the attempt fails, and pg-boss retries it, as today. The
  environment can still lower it, and the tests do.
- **The expiry.** The prepare-session queue's `expireInSeconds` goes from 240 to 600, keeping
  phase 19's rule that expiry is twice the budget. Expiry is what detects a worker that crashed
  mid-call, and it must never cut off a healthy call. Today the two numbers agree only through a
  comment. The default budget moves to `domain/jobs.ts`, where both `config.ts` and `db/jobs.ts`
  read it, and a unit test asserts the rule.
- **Retries stay at two. (low confidence)** They recover the common, fast failures: a 503, or an
  answer that fails validation. In the worst case, three attempts each time out, so the session
  shows "preparing" for about 15 minutes before it is marked failed. The learner can skip at any
  time, and the app polls with no limit. With one retry the worst case is 10 minutes, but a
  passing 503 would then fail a session twice as often.
- **Each call does less work, not more.** A ten-word session sends the model ten items today.
  Under D3 it sends at most seven: dictation and tiles need no item, and a board's four words
  need one. The `gap` task's sentence lengthens the request, not the answer, and the model's
  answer is what dominates a call's time.
- **Measured, not felt.** The `session_prepared` log event gains `model_ms` and `item_count`, so
  the slowness can be traced per session and by item count.

Rejected: a budget above five minutes, which is Victor's cap.

---

## 2. Changes

### `packages/core`

- `api/schemas.ts`, new union members:
  - `ListenChoiceQuestion`: `id`, `type`, `vocab_term_id`, `question` (the form, spoken and later
    shown), `options`, `correct_option`.
  - `DictationQuestion`: `id`, `type`, `vocab_term_id`, `question` (the form), `meaning` (shown
    after the answer, and read by the missed list).
  - `MatchingQuestion`: as `ListenChoiceQuestion`, plus
    `board: { question_ids, words, correct_options }`.
  - `LetterTilesQuestion`: `id`, `type`, `vocab_term_id`, `question` (the Hebrew),
    `part_of_speech`, `answer`, `tiles`.
  - `ClozeChoiceQuestion` (Part B): `id`, `type`, `vocab_term_id`,
    `sentence`, `gap: { start, end }`, `translation`, `meaning`, `options`, `correct_option`.
  - `ClozeTypedQuestion` (Part B): `id`, `type`, `vocab_term_id`, `sentence`, `gap`,
    `translation`, `question` (the Hebrew), `part_of_speech`, `answer`, `lemma`, `alternatives`.

  Other schema changes:
  - `CreateSessionRequestSchema` gains `listening: z.boolean().optional()`.
  - `LlmDistractorsSchema` is unchanged: the `gap` task answers with `distractors`.
- `domain/quiz.ts`: `isChoice` covers the five option types. `answerFits`, `rightAnswer`,
  `evaluate` and `missed` cover all nine. `shuffleOptions` leaves a matching question alone,
  because a board is shuffled once, by the service.
- `domain/typed.ts`: `judgeTyped` takes its target (`answer`, `lemma`, `alternatives`) instead of
  a whole question, so typed, cloze-typed and dictation share it. Dictation passes the form as
  both answer and lemma and no alternatives. `judgeTiles` is new (exact or wrong).
- `domain/progress.ts`: `LIVE_DIMENSIONS` gains `spoken_receptive` (D13).

### Server

- **Migration 0016 (Part A).** `questions.tiles text[]`. `questions_type_known` admits the four
  Part A types. `questions_shape_valid` gains:
  - `listen_choice` and `matching`: options, no prompt, alternatives or tiles;
  - `dictation`: a prompt, no options, alternatives or tiles;
  - `letter_tiles`: a prompt and 5 to 12 tiles, no options or alternatives.

  Every existing row passes unchanged, since none has tiles.
- **Migration 0017 (Part B).** `questions.sentence`, `sentence_translation`, `gap_start` and
  `gap_end`. The type check admits `cloze_choice` (options, a prompt and the four sentence
  columns) and `cloze_typed` (a prompt, alternatives and the four sentence columns). The four are
  null for every other type, and `0 <= gap_start < gap_end`.
- **`answers` is unchanged.** Dictation's and the tiles' verdicts are within
  `answers_verdict_known`.
- `domain/session.ts`: `planSession(picks, { listening, ordinal })` replaces `TYPE_CYCLE` and
  `typeFor`, and returns each position's type and the board's positions (D3, D4, D10).
  `eligibleTypes(pick, listening)` is pure.
- `domain/cloze.ts` (new, Part B): `findGap(sentence, [form, lemma])`.
- `domain/tiles.ts` (new): `tileEligible(form)` and `tilesFor(form, alphabet, rng)`. The alphabets
  live with the languages in `domain/languages.ts`.
- `domain/progress.ts`: `AnsweredQuestion` covers the new types, and `evidenceFor` implements D12.
- `domain/distractors.ts`: `taskFor` returns null for the types that need no model, and items are
  built only for the rest. The `gap` task (Part B) sends the sentence and asks for D9's wrong
  words. `badChoice` validates it as it does `word`, with no wrong option in the explanation's
  script and none equal to the form or the lemma. `generatedContent` covers every type, and
  `boardContent` builds the four questions' shared options and the extra meaning (D10).
- `domain/jobs.ts`: the prepare-session payload gains `listening` (default false) and `ordinal`
  (default 0). `SESSION_GENERATION_BUDGET_MS = 300_000` and the expiry derived from it live here
  (D16).
- `config.ts`: `sessionGenerationTimeoutMs` defaults to the budget above.
- `db/jobs.ts`: the prepare-session queue's `expireInSeconds` is the derived expiry, 600.
- `repo/questions.ts`: `findGenerationContext` also reads `example_source` and `example_target`.
  `questionFrom` builds every shape. `withBoards` gives consecutive matching questions their
  `board`. `insertGeneratedQuestions` writes the new columns.
- `repo/sessions.ts`: `countListSessions(enrollmentId)` gives the ordinal.
  `insertSessionQuestions` takes a board's shared order. `loadSession` attaches boards.
- `repo/progress.ts`: `findSnapshot` reads the meaning per D15. `findSessionEvidence` reads each
  answer per type.
- `services/sessions.ts`: `createNextSession(enrollmentId, { listening })` puts the flag and
  the ordinal in the payload. `prepareSession` plans, calls the model only when an item needs it,
  builds the tiles with its rng, shuffles the board once and writes. Its `session_prepared` event
  gains `model_ms` and `item_count` (D16). The duration comes from a new collaborator, `now`,
  which `index.ts` passes as `Date.now` through `createServerDeps`, exactly as it passes
  `Math.random` as `rng`. ADR 0002 counts a clock among what is received rather than reached
  for, and the test composition root passes a fake.
- `routes/sessions.ts`: the create body's `listening`, and the new types in the published API.

### Mobile

- `components/MultipleChoiceView.tsx` takes its prompt as a node, so the listening and cloze
  choice cards reuse it. `TypedAnswerView` does the same for dictation and cloze-typed.
- New components:
  - `ListenPrompt` (the large play button that auto-plays, D6);
  - `SentenceGap` (a sentence with its gap, left to right, filled after the answer);
  - `MatchingBoardView` (D10);
  - `LetterTilesView` (D11).
- `feedback.ts`: `feedbackFor` covers every type (D14).
- `hooks/useSession.tsx`: `submitBoard(firstAttempts)` sends a board's answers in order and
  queues the last response, as one answer's is queued today.
- `hooks/useNextSession.tsx`: sends `listening: canSpeak(target)`.
- `app/session.tsx`: the exhaustive switch over nine types.
- `strings.ts`: D14's instructions and banners, the no-voice line, and the tiles' buttons.

### Eval (Part B)

- `DistractorCase` items may carry `sentence`, and `task: 'gap'`.
- **Tier 1:** a `gap` item has three distinct wrong words, in the learned language's script, none
  of them the form or the lemma.
- **Tier 2:** none of the wrong words is a known word that fits the sentence (`fits`, listed per
  case, like `synonyms`).
- **New cases:** one batch per target language, built from real examples in the dictionary. Each
  has at least one sentence where a careless distractor would fit (`I want to ___ a table`).

---

## 3. Testing

### Unit

- **core:** `judgeTyped` with a dictation target (the lemma is wrong, a synonym is wrong, a
  missing accent is a near miss); `judgeTiles`; `evaluate` and `rightAnswer` per type; the union
  parses all nine shapes.
- **server domain:**
  - `planSession`:
    - runs of three in tier order, and the board after the first run at 7, 8, 9 and 10 picks and
      never below 7;
    - the rotation over ordinals 0–2 shows every type;
    - an ineligible pick falls through to the next type, ending at the base type;
    - listening off excludes both listening types;
    - no board when four distinct picks cannot be found, as with two senses of one word or two
      words with one meaning;
    - two cards in a row never share a type, over all sizes 1–10.
  - `findGap`: whole words only, any case, the lemma when the form is absent, a multi-word form,
    Cyrillic, and no gap for zero or two occurrences.
  - `tileEligible` and `tilesFor`: two extra letters, stress removed, a seeded rng reproduces the
    tiles.
  - `evidenceFor`: every row of D12.
  - `boardContent`: the extra meaning skips a colliding distractor; all three colliding is a
    refusal.
  - `gap` validation (Part B).
- **server services (fakes):** `prepareSession` with listening on and off; no model call when no
  item needs one; a board's four questions share one shuffle; `session_prepared` logs
  `model_ms` from the fake clock and `item_count`. `createNextSession` puts the ordinal and the
  flag in the payload.
- **generation budget (D16):** the config default is the budget, and the prepare-session queue's
  expiry is at least twice it.
- **mobile:** `feedbackFor` per type; the board's first-attempt bookkeeping, including a resume
  with words already matched; tile placement and removal.

### Integration (real Postgres)

- the migrations keep every existing question, and each new shape check refuses a row of the
  wrong shape;
- a list session prepared through the queue holds the planned types in order, with a board whose
  four rows share their option order, and tiles stored;
- `loadSession` attaches the board, and answers to a board's four questions round-trip;
- `findSnapshot` shows form → meaning for every type;
- the create route accepts `listening`; a session prepared from an old payload with no flag has
  no listening cards;
- the recompute writes back what the live path wrote, for a session holding every Part A type.

### E2E

The voice spec's init script supplies voices and records what is spoken. An e2e learner is new,
so their first list session has ordinal 0, and saved words chosen to be eligible for every type
make each position's type known (D3).

- **Part A:** `listening-variety.spec.ts` saves ten Italian words and plays a list session:
  - a listening card plays on arrival (the recorder has its text);
  - the board is matched with one deliberate wrong pairing, and the banner reads 3 of 4;
  - a tiles card is built;
  - a dictation is answered from the recorded text.

  A second session, at ordinal 1, shows the types the first did not. The word's page then shows
  `הבנת הנשמע` above טרם תורגל.
- **Part B:** a session with gap cards. The choice card shows no Hebrew until answered and then
  the translation. The typed card accepts the lemma.
- `next-session.spec.ts`, `progress.spec.ts` and `question-types.spec.ts` answer each card by its
  type, and expect the four-dimension badge.

### Eval

The `gap` cases (§2), run against the real model until they pass reliably. A failing case changes
the prompt, never the threshold.

---

## Build order

**Part A (PR 1):**

0. The generation budget and expiry, with the log fields (D16). It is independent of the
   cards, and it helps today's sessions as soon as it lands.
1. Core: the union members, the judge's target, `judgeTiles`, `LIVE_DIMENSIONS`.
2. Server domain: `planSession`, tiles, the evidence table, the board's content.
3. Migration 0016, the repositories, the service, the route.
4. Mobile: the listening prompt, dictation, the board, tiles, feedback, the create flag.
5. Integration and e2e.

**Part B (PR 2):** `findGap`, the `gap` task and its eval cases, run against the real model;
migration 0017; the two cloze cards; their tests.

## Risks

- **Badges drop once** (D13), by at most one level. Announced in the PR.
- **A long wait before a failure.** With a five-minute budget and two retries, a model that
  keeps timing out leaves a session "preparing" for about 15 minutes (D16). If `model_ms` shows
  calls near the cap, the remedy is a smaller or faster call, not a longer budget: fewer items
  per call, or the model's thinking budget.
- **Listening without headphones.** With no "can't listen now" (D6), a learner on a bus may skip
  sessions or guess, and a guess restarts a gap. The switch signal is in D6.
- **Russian gets fewer gap cards** (D8): 17 of 24 examples today, against 35 of 42 for English and
  19 of 21 for Italian. Model-named spans are the remedy if it matters.
- **A `gap` distractor that fits the sentence** makes a right answer look wrong. Tier 2 catches the
  fitting words a case lists, not every one. Watch for reports of an unfair gap card.
- **Elimination on the board** over-credits a little (D10). If badges climb on matching alone,
  cap matching at 3 as reverse choice is.
- **Auto-play may be refused by a browser** that does not count the advancing tap as a gesture.
  The play button still works. A device is unaffected.
- **E2E time grows** with nine card types to drive. Part A's e2e adds one spec, not a step to
  every existing one.
