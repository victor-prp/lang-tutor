# Phase 50 — A word that sounds the same is understood

- **Status:** Designed with Victor on 2026-10-14 from his bug report, in chat: the diagnosis, a
  first design (the transcriber lists homophones) that he rejected because an LLM's list can be
  incomplete or wrong, then a second (a stored check of one pair) that he approved with one
  correction: a 0–1 score rather than yes or no, with a configurable threshold starting at 0.95.
  Then "go till PR": the plan was executed inline, and the calls it needed are the rulings at
  the end.
- **Date:** 2026-10-14
- **Source:** Victor's report: "When I had to say 'cell' I did it well but it interpreted it as
  'sell'. Any retry still interprets it as 'sell', so the pronunciation of this gloss never
  progresses."
- **Builds on:** phase 25 (speaking: D1 blind transcription, D5 nothing recorded when unheard, D6
  the judge, Risks: homophones), phase 27 (the judge client, a learner-waiting call), phase 34 D9
  (the second try), phase 47 (`model_calls`).
- **Touches:** the spoken judge in core (`spoken.ts`, `quiz.ts`'s `evaluate`), the step's
  refusal (`domain/session.ts`), a new pure domain module and model task, a new table and
  migration 0034, `answerBySpeech`, config, the eval. No change to the transcriber, no wire
  change, no app change.

---

## Goal

A speaking card judges letters, not sounds. The transcriber is blind (phase 25 D1): it is told
the language and never the expected word, so a learner who says *cell* correctly is written down
as the more common *sell*. `judgeSpoken` finds no `cell` among the heard words and returns
`unheard`, which records nothing (D5). Every retry hears the same sound and writes the same word,
so on a read-aloud card, whose only way out is skip, the gloss's spoken skill can never move.
The same holds for every homophone the transcriber prefers another spelling of: *two*/*too*,
*knight*/*night*, Russian *луг*/*лук*, Italian *hanno*/*anno*. Phase 25's Risks named this,
and its switch signal ("the app often mishears a word he said right") is this report.

**Done means:**

1. A read-aloud card for `cell` whose clip is heard as `sell` is understood and recorded, and
   its gloss's spoken evidence moves (D1–D5).
2. A pair already scored costs no model call (D3).
3. Near misses stay unheard: `sheep` for `ship`, `bat` for `bad`, `люк` for `лук` (D2, D8).
4. `npm run eval` has a sound-alike group that passes `TIER2_THRESHOLD` without lowering it. The
   transcription rows are unchanged, since the transcriber's prompt is (D8).
5. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:** the second look at an unheard transcript (D1), the score and its prompt (D2), the stored
scores (D3), the threshold (D4), how a sound match is recorded (D5), what a failed score costs
(D6), the events (D7), the eval (D8).

**Out:**

- **Changing the transcriber.** It stays blind and its prompt and schema stay as they are. The
  first design, the transcriber listing every spelling that sounds the same, is rejected: it asks
  the model to recall a complete list, and a missing entry or a near miss in it goes unseen.
- **Alternatives by sound.** Only the card's own forms are compared (D1). A homophone of an
  alternative stays unheard, as today.
- **The app and the banner.** A sound match is `understood`, and the banner says what it says
  today: "נכון! שמענו: sell". It is right, and it is what was heard.
- **Typed and dictation homophones** (phase 34's category I, `ho` / `o` / `oh`).
- **A "my answer was right" button** for mishearings that are not homophones (accent, a clipped
  clip). Phase 34 left it out; so does this phase.
- **A backfill.** An unheard attempt was never recorded, so there is nothing to re-judge.

## 1. Decisions

### D1. An unheard transcript gets a second look, by sound

`answerBySpeech` transcribes and judges exactly as today. When the verdict is `unheard` and the
transcript is not empty, it builds the **pairs** to score and asks how alike each sounds.

A pair is a run of the card's form and a stretch of the heard words of the same length, both in
the judge's own words (`spokenWords`: typed normalising, diacritics folded, elisions dropped).
The form's runs are `runsOf`'s, with and without a leading article or "to", so the sound check is
as lenient as the letter check: the judge already accepts a form found inside more words (phase
25 D6), and this accepts a sound-alike found there too.

- **The forms** are `spokenTarget`'s: read aloud, the form shown; say the translation, the answer
  and its lemma. Not the alternatives (Scope).
- **A new pure function** in `packages/core/src/domain/spoken.ts`, `soundPairs(target, heard)`,
  beside `judgeSpoken`, which keeps `runsOf` private to the module. It returns the pairs
  deduplicated, each ordered so that `(sell, cell)` and `(cell, sell)` are one, and at most 8 of
  them, the forms' pairs first. A transcript is at most 100 characters and a form at most four
  words, so 8 covers every realistic case; a longer transcript loses its last stretches.
- **The best score decides.** If any pair's score reaches the threshold (D4), the verdict is
  `understood` (D5). Otherwise it stays `unheard`, as today.

For `cell` heard as `sell` there is one pair, `(cell, sell)`. For `il gatto` heard as `ho visto
un gatto` (already understood by letters) no pair is built.

### D2. The score: one text call, 0 to 1, about two spellings

The call sees no audio. It is given the language and the pairs and returns, for each, how alike
the two are **when said aloud in the language's standard pronunciation**: 0 completely different,
1 identical (Victor, 2026-10-14).

- **Why this keeps D1's promise.** Phase 25 kept the transcriber blind because a model told the
  expected word tends to hear it. This call hears nothing: the hearing is over, and its result is
  kept as it is. The call answers a question about two written words.
- **Why it is more reliable than a list.** The model has both words in hand and judges one pair,
  instead of recalling every homophone of the heard word without knowing which one matters.
- **The scale is anchored in the prompt**, because a model's free number means little on its own:
  1 for spellings said the same (homophones); about 0.8 for one sound different, such as a vowel's
  length or a consonant's voicing; 0.5 or less for several sounds different; 0 for nothing in
  common. The prompt's examples are deliberately not the eval's cases, as `accept.ts`'s are not,
  so the eval measures the rule and not recall of it.
- **"Standard pronunciation"** includes the ordinary rules of connected speech that change how a
  word is said, such as Russian final devoicing (`луг` is said `лук`) and Italian's silent `h`.
  For English, a pair said the same in either General American or Received Pronunciation counts as
  the same.
- **Pure** (ADR 0001 R3): a new `apps/server/src/domain/soundAlike.ts` holds the prompt, its
  marker for MockServer (`how alike they sound`), and the parse. The schema,
  `LlmSoundAlikeSchema` in core, is `{ scores: [{ key, score }] }`, every field required (an
  optional string can hang a Gemini call). Each score is matched back to its pair by the short key
  it was sent with (`p1`, `p2`, …), never by position (ruling R1). A score outside 0–1, a pair not asked about, or a pair asked about and
  missing is dropped: that pair is unscored, which counts as below the threshold.
- **A new model-call kind**, `sound_alike` (phase 47 D3). It runs on the `judge` client: a learner
  is waiting on it, as on the meaning judge, and the judge's 8 s budget applies.

### D3. Scores are stored, shared, and asked once per pair

A new table, `pronunciation_scores`, holds one row per language and pair: `language_code`,
`form_a`, `form_b` (`form_a < form_b`), `score` (real, 0 to 1), `created_at`. The primary key is
`(language_code, form_a, form_b)`.

- **Before calling**, `answerBySpeech` reads the stored scores of its pairs. Only the pairs
  missing are sent to the model, in one call, and their scores are inserted `ON CONFLICT DO
  NOTHING`, so two learners racing on the same pair keep the first score.
- **Outside any transaction** (ADR 0001 R8): the read, the call and the insert each stand alone,
  as the transcription does. A score is a fact about two words in a language, true whatever
  happens to the answer that asked for it.
- **Shared by every learner of the language**, as the dictionary is: a pair scored once is
  scored for everyone. A wrong score is one row to see and correct (Risks).
- **Not a `dict_` table**: it is keyed by what a learner said, not by a dictionary entry, so
  `db:reseed` leaves it alone and the dictionary export does not carry it.
- **The score is stored, not the verdict**, so a new threshold applies to every stored pair at
  once, with no call.

### D4. The threshold is configured, 0.95 to start

`SOUND_ALIKE_THRESHOLD`, read by `config.ts` as the other knobs are, defaults to 0.95 (Victor,
2026-10-14). A value that is not a number in (0, 1] falls back to the default. The default is a
named constant in `domain/soundAlike.ts`, which the eval imports, so the eval checks the same
line the server draws. Production needs no setting until Victor wants another line.

### D5. A sound match is recorded as understood

The verdict is `understood`, the same as a letter match: no new verdict, so score, evidence,
progress and the app read it unchanged. The answer stores what was heard (`sell`), as every
spoken answer does.

- **The answer the server builds** gains a member, `{ heard: string; sounds_like: string }`, the
  form it matched. `evaluate` records it as `understood` without re-judging the letters, and the
  step's refusal does not call it unheard. As with phase 27's `judged`, only the server builds it:
  the next-step schema has no `sounds_like`, so a client cannot claim a sound match.
- **The app's `CardAnswer`** excludes every `heard` member of `AnswerInput` already, so it needs
  no change.
- **The second try** (phase 34 D9): a retry clip is transcribed, judged and given the same second
  look as a first one.
- **A replay** returns the stored verdict, `understood`, as it does for a letter match.

### D6. A failed score costs nothing more than today

A score call that fails (timeout, `LlmUnavailable`) or that is unreadable leaves the verdict
`unheard`, stores nothing, and logs `sound_alike_failed`. The learner sees "לא הבנו. שמענו: sell"
and can try again, as today. It is not a 502: the transcription, which the learner paid two
seconds for, succeeded.

### D7. The events

`speech_judged` gains, when the second look ran:

- `sound_score`: the best score, or null when none came back;
- `sounds_like`: the form of the best pair;
- `sound_ms`: the wait for the read, the call and the insert;
- `sound_called`: whether the model was called, or every pair was already stored.

With the stored row and the call's `model_calls` record (phase 47), "why was `sell` understood
for `cell`?" is answerable from lane 0 after the fact.

### D8. The eval

A new group of cases, `SOUND_ALIKE_CASES`, in `tests/eval/cases.ts`: a language, two words, and
whether they should land at or above the default threshold (`same`) or below it (`different`).

| Language | Same | Different |
|---|---|---|
| English | cell/sell, two/too, knight/night, flour/flower, see/sea, whole/hole, mail/male | ship/sheep, bat/bad, taught/thought, live/leave, cut/cat, pet/pat, walk/work |
| Russian | луг/лук, плод/плот, код/кот, пруд/прут, гриб/грипп | люк/лук, лес/лис, мел/мель, брат/брать |
| Italian | hanno/anno, ho/o, hai/ai | gatto/gato, pala/palla, caro/carro, cane/pane |

- **Tier 1:** the answer parses with a score for every pair, including one batch case of three
  pairs in one call, the shape the server sends for a longer transcript.
- **Tier 2:** each case's score is on the right side of the default threshold, pooled into its own
  line, `sound alike tier 2`, against `TIER2_THRESHOLD`.
- **The report prints every score**, so a later change of threshold is chosen from evidence: where
  `same` and `different` actually fall.
- Each case is its own call, as the common case is one pair.

## 2. Testing

- **Core unit:** `soundPairs` (one word, an article, a word inside more words, a phrase, the cap,
  the ordering, nothing when letters matched); `evaluate` records a `sounds_like` answer as
  understood; the step refuses a bare `heard` that is unheard and accepts a `sounds_like` one.
- **Server unit:** the prompt and the parse (matched by key, out-of-range and stray pairs
  dropped); config's threshold (default, a valid value, junk falls back); `answerBySpeech` with a
  fake judge and fake repo: a stored pair calls nothing, a missing pair calls once and stores, a
  score below the threshold stays unheard and records nothing, a failed call stays unheard and
  logs, a letter match never reaches the second look, and the retry clip gets it too.
- **Integration:** the repo's read and `ON CONFLICT DO NOTHING` insert against Postgres, the
  table's checks, migration 0034.
- **E2e:** one read-aloud card whose MockServer transcript is a homophone and whose MockServer
  score is 1 shows "נכון!".

## Risks

- **A model's score is not a measurement.** Scores tend to cluster on a few values (1, 0.9, 0.8),
  so 0.95 in practice means "the model said the same or nearly". The anchored scale (D2) and the
  eval's printed scores (D8) are what make the line meaningful; if `different` cases crowd it, the
  line moves with evidence, not by guess.
- **A wrong high score credits a near miss for every learner of the language,** permanently, since
  scores are stored (D3). The `different` half of the eval guards the class; for a single bad row,
  `UPDATE pronunciation_scores SET score = 0 WHERE language_code = 'en' AND form_a = 'sheep' AND
  form_b = 'ship'` corrects it. Deleting the row only asks again,
  and the model at temperature 0 likely repeats itself.
- **A wrong low score** for a true homophone leaves that pair where it is today, stuck, until
  someone corrects the row.
- **The wait on a miss is one more call**, unmeasured until the eval runs; `sound_ms` measures it
  in use. It is paid only on a miss, and only the first time a pair comes up.
- **Leniency inside more words.** `I sell` for `cell` is understood, as `I cell` would be by
  letters (phase 25 D6, low confidence there too).
- **Accent is not judged here.** The transcriber heard the learner; this compares two standard
  pronunciations. A learner whose `ship` is heard as `sheep` stays unheard, which is the point.

## Rulings

Made while executing the plan; each with what it costs if wrong.

- **R1. Scores come back under a short key, not the two words** (D2). Phase 19's reason: a key
  is one the model cannot mistype, and an echoed word can come back respelled. Costs nothing if
  wrong.
- **R2. The order check compares under `COLLATE "C"`** (D3). The server orders a pair by code
  point; the database's own collation could order it the other way and refuse the insert. Wrong
  only for a letter outside the Basic Multilingual Plane, which no target language uses.
- **R3. The threshold is a required dependency**, of the session service and of the composition,
  as `stockSaveDelaySeconds` is (ADR 0002 R5 forbids defaulted collaborators). Only the test
  helpers and `config.ts` default it.
- **R4. One catch covers the read, the call and the write** (D6). A database failure in the
  second look leaves the transcript unheard and logs `sound_alike_failed`, as a model failure
  does. If wrong, an outage reads as "not understood" for that attempt rather than as a 500.
- **R5. The prompt's 0.8 anchor names one consonant for another and a consonant held long or
  short** (D2, D8). The first eval run scored `taught`/`thought` and `gato`/`gatto` at 1: the
  over-credit this phase guards against most. The anchor now gives `thin`/`tin` and Italian
  `nono`/`nonno`, and says a difference a native listener can hear is never 1. After it the group
  passed 33/33 in three runs. If wrong, a true homophone scored below 1 stays unheard, as today.
  The final review asked whether that rule, worded for every language, now costs English
  homophones spelled with a doubled letter, and whether the Italian cases only measure recall of
  the prompt's example. Nine held-out cases answer it (`allowed`/`aloud`, `meddle`/`medal`,
  `cannon`/`canon`, `bury`/`berry` the same; `tree`/`three`, `bat`/`bath`, `fato`/`fatto`,
  `sete`/`sette`, `copia`/`coppia` apart): all on the right side, three runs out of three, so the
  rule stays worded as it is.
- **R6. Integration and e2e run in CI only.** All nine lanes were in use, so this worktree has
  none; unit tests, typechecks, the ADR checks and the sound-alike eval ran locally.

## Measured

The eval's sound-alike group, 40 cases (42 pairs) after the review's additions, three runs on
2026-10-14 each before and after them, every score identical across runs:
homophones 1; one sound apart 0.8; `work`/`walk` 0.5. The scores sit on the prompt's anchors and
nowhere else, so today any threshold between 0.8 and 1 draws the same line, and 0.95 means "the
model said identical". Each call took about 0.6 s (31 calls in 5 s at a concurrency of 4).
