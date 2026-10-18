# Phase 62d — A typed gap's sentence points to its word

- **Status:** design agreed with Victor on 2026-10-18 (the bar: "the verdicts are good to me"; the
  rest as played back), then "go till PR": self-approved under *Continue till PR*, built inline on
  branch `phase-62d-typed-gap-points`. Builder check done; its four questions settled as my calls
  (D1's two rewrite calls, D6's Italian labels, a degraded card's one failure, the list share).
- **Date:** 2026-10-18
- **Source:** the investigation and brainstorming of 2026-10-18 (memory note
  `typed-gap-points-to-nothing`), from Victor's lane 0 sessions as `vic1`.
- **Builds on:** phase 62 (gap sentences short and from the learner's words; ruling R5: pointing
  comes first), phase 62c (a gap to choose the checker refuses gets one rewrite), phase 41 (the
  eval's pointing probe), phase 38 (the typed gap's hint), phase 27 (a sentence card that fails
  becomes a typed translation).
- **Touches:** a new pure module `domain/pointing.ts`, the rewrite in `domain/distractors.ts` and
  `domain/gapRewrite.ts`, `prepareSession` in `services/sessions.ts`, model call kinds
  (`services/llm.ts`), the job's budgets (`domain/jobs.ts`), the response schema
  (`packages/core`), the prompt evals, unit and service tests.

---

## Goal

The typed gap card (`cloze_typed`) shows an Italian sentence with the practised word left out, and
Victor types the word. Its hint opens the Hebrew translation, which gives the word away. Since
phase 62 the sentence is short and built from his list, and with a list that is mostly glue words
(io, ho, qui, ora, con, poi, ci sono) the model writes sentences any word completes:

- On 2026-10-18, 12 of his 24 typed gaps pointed to nothing: "Il ___ è qui." (cielo),
  "Io ho un ___." (pesce), "Ho una ___ qui." (sedia), "Io sono ___ ora." (felice).
- He opened the translation on all 10 of those he answered, and on 3 of the 8 that pointed.
- All 20 typed gaps before phase 62 pointed (they were long and full of unknown words instead).
- The model knows: its own `alternatives` for "Il cielo è qui." are ten unrelated nouns (tavolo,
  fratello, pesce, lavoro, tempo, città, libro, cane, gatto, sole).

Victor: the sentence should be "as simple as possible, but not simpler": he must be able to tell
which word goes in the gap without opening the translation.

**Done means:**

1. In Victor's sessions, a typed gap card either points to its word or is not shown as a gap.
2. The pointing check agrees with Victor's verdicts (§ Eval), and the typed gap rows pass the same
   check on the sentence production would show.
3. `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass.

## The bar (Victor, 2026-10-18)

Cover the gap: a reader's **first guess** is the word, or a word of the same meaning, and it is
**clearly** the likeliest. Narrowing to a kind (any person, any vehicle) is not enough. A sentence
may be longer, or use words outside the learner's list, when that is what makes it point: tapping
a word shows its translation.

Order of priority (Victor): (1) it is clear which word goes in the gap; (2) short, and from the
learner's list where possible; (3) any other word is fine.

His verdicts, which the eval keeps as the check's own cases:

| # | Sentence | Word | Points |
|---|---|---|---|
| 1 | The ___ is here. | sky | no |
| 2 | The ___ is blue today. | sky | yes |
| 3 | The ___ is arriving now. | train | no |
| 4 | The ___ leaves from platform 3. | train | yes |
| 5 | My ___ is happy. | brother | no |
| 6 | My ___ and I have the same parents. | brother | no |
| 7 | My parents have two sons: me and my ___. | brother | yes |
| 8 | I have a ___ here. | chair | no |
| 9 | Sit on the ___ next to the table. | chair | yes |
| 10 | Open the ___, it's hot in here. | window | yes |
| 11 | The city is ___. | big | no |
| 12 | An elephant is a very ___ animal. | big | yes |
| 13 | I am ___ now. | happy | no |
| 14 | I'm ___ because today is my birthday. | happy | yes |
| 15 | I have ___ now. | time | no |
| 16 | Sorry, I have no ___, I'm late. | time | yes |
| 17 | First we eat, ___ we go to the cinema. | then | yes |
| 18 | I drink coffee ___ milk. | with | yes |
| 19 | I have a ___. | fish | no |
| 20 | The ___ swims in the water. | fish | yes |

## Goals, non-goals, anti-goals

**Goals**

- Every typed gap the batch wrote is checked against the bar before the session is written.
- One that fails is rewritten once, told what a reader guessed, and checked again.
- One that still fails, or whose rewrite fails, becomes a typed translation (Victor's ruling R3).

**Non-goals**

- The gap-to-choose card: its options decide the word, and far-off wrong options are fine
  (memory `cloze-choice-easy-is-fine`). Its 62c rescue is unchanged.
- A typed gap that validation degraded (no usable sentence at all): it becomes a typed
  translation, as today.
- The sentence translation card and the context lines: they show the word.
- The capitalised saved word leaking into a sentence ("Io ho un Treno."): a separate fix.

**Anti-goals**

- Any change to the batch prompt as the session's main call sends it, or to the 62c rewrite's
  prompt for gap items: at temperature 0 a changed prompt re-rolls every task in it
  (memory `gap-eval-temperature-zero-lottery`).
- Lowering `TIER2_THRESHOLD`, loosening an eval assertion, or skipping or deleting a case.
- A session that fails because the check or the rewrite failed.

## Design

### D1. The call sequence

```
62c:  generation → context call (word maps) ─────────────────────────────────────┐
                 → gap check (choice) → [rewrite] → [validate] ───────────────────┴→ checker
                                                                                   + rescued cards' word maps

62d:  generation → context call (word maps) ─────────────────────────────────────┐
                 → gap check (choice)   → [gap rewrite]      → [validate] ────────┤
                 → point check (typed)  → [sentence rewrite] → [validate] ────────┴→ checker
                                                                                   + rescued cards' word maps
                                                                                   + point check of rewritten typed gaps
```

- **The point check** runs beside the gap check, both beside the context call, once the batch is
  validated: one call with every typed gap validation kept.
- **Two rewrite calls, side by side** (my call, from the builder check): 62c's, for gap items
  only, exactly as today; and a sentence rewrite for typed gaps only. One mixed call would send
  62c's rewrite a prompt no eval measures, and its rule ("an item with rewrite is a gap item")
  would be false for half the call.
- **The re-check** asks the point check again for the rewritten typed gaps only, beside the final
  checker and the second word-map call. A session where nothing fails waits for nothing new: the
  point check is small and ends inside the context call.

### D2. The point check (`domain/pointing.ts`)

A call of its own, with a prompt written for this, not a task added to the checker's prompt
(adding one would change every checker call's prompt). It is **blind**: each item is the sentence
with `___` and its key, never the word, so the reader cannot be led to it.

- **Asks, per item:** `guesses`, the three words a native reader would most likely put in the
  gap, likeliest first, in the form the gap needs; `meaning`, the first guess in the learner's
  language; `clear`, true when one meaning is clearly the likeliest (the words a reader would put
  first all mean about the same), false when words of different meanings fit about as well.
- **Schema:** every field required, no optional strings (memory `gemini-optional-strings-hang`).
- **Passes** when `clear` is true and the first guess is the word, or means the same:
  - **the word:** `judgeTyped` against the gap's form, the row's form, lemma and answer form,
    and its accepted answers. Never the card's generated `alternatives`, which for a sentence that
    points to nothing are exactly the unrelated words.
  - **the same meaning:** `meaningFits(meaning, glossMeanings(row))`, as the context line's check
    reads a meaning.
- **Fails** otherwise, with the feedback the rewrite is told: the guesses, and whether it failed
  because several meanings fit (`clear` false) or because the reader guessed another word.
- **Client:** the gap check's (`gapCheckLlm`), its budget and model. **Kind:** a new
  `ModelCallKind`, `gap_point`, for both the check and the re-check. `kind` is plain text in
  `model_calls`, so no migration.
- **Marker:** a phrase only this prompt carries, exported for MockServer stubs.

### D3. The rewrite of a typed gap

- **Which:** every typed gap the point check judged and failed. One it left unanswered, or a point
  check that failed (error, timeout, unreadable), rescues nothing and keeps its cards as today
  (my call: fail open, as 62c's gap check does, so a provider hiccup never costs a session its
  typed gaps).
- **The fault** is a `GapFault` with a new stage, `pointing`. Its `rewrite` carries the old
  sentence, the reader's guesses in `fits`, and in `problem` why (several meanings fit, or the
  reader guessed another word). The old sentence is added to the item's `avoid`.
- **Prompt:** `buildDistractorPrompt` with the rewritten typed gaps alone, on the rewrite's client
  (`gapRewriteLlm`, kind `gap_rewrite`), in a call of its own (D1). A rule of its own for
  a rewritten **sentence** item is added only when one is asked: the old sentence could not be
  used, because a reader who covers the word guesses the words in `rewrite.fits`; write a new one
  around another verb or phrase that makes this word, or one of its meaning, the clear first
  guess (what only it does, where only it is, what goes only with it), never the old sentence
  with a word changed; words outside `learner_words` are allowed wherever pointing needs them,
  since the learner can tap any word; keep the learner's words where it still points with them;
  up to 12 words. 62c's gap rule is added only when a **gap** item is asked again, so every call
  that exists today sends exactly today's prompt (a unit test pins it).
- **Validation:** `validateDistractors` as in 62c, with a rewritten sentence item allowed up to
  `SENTENCE_MAX_WORDS` (12) words instead of `SHORT_SENTENCE_MAX_WORDS` (8). Every other check is
  unchanged.
- **Examples in the rule** use no word the eval asks (62c R5: examples get copied): "Il ___ è qui."
  points to nothing; "Leggo un ___ prima di dormire." points to libro.

### D4. After the rewrite

- **A rewrite that validates** replaces the card's content (sentence, translation, gap,
  alternatives), as 62c's rescue does. Its word map comes from the second word-map call, its
  Hebrew goes to the final checker's `translate` test as any typed gap's does, and its sentence to
  the re-check.
  - **The re-check passes:** the card is kept.
  - **It fails:** the card becomes a typed translation (phase 27's degraded path, as the checker's
    `translate` test degrades one): `sentence_degraded` with the reason, and in a question-types
    session it is not generated (phase 61 D5).
  - **The re-check call fails:** the rewritten card is kept (my call: it was asked to point, and
    the old one is known not to).
- **A rewrite that fails** (the call, its answer, or validation of the item): the card becomes a
  typed translation, as above. Never the old sentence (Victor's R3).

### D5. Logs and budgets

- `gap_rewritten` (62c's event) for a typed gap too, with `type: 'cloze_typed'`, `reason`
  (`pointing`, with the guesses), `old_sentence`, and `new_sentence` or `failed`.
- `point_check_failed` when the call fails, as `gap_check_failed`.
- `session_prepared` gains `point_check_ms`, `point_count` (typed gaps checked) and
  `unpointed_count` (failed the first check).
- `PREPARE_SESSION_CALL_BUDGETS_MS` gains the gap check's budget twice (the point check and the
  re-check) and the rewrite's once (the sentence rewrite), counted as if one after another, as
  that list's rule says; the job's expiry rises with it (840 s to 1200 s).

### D6. Eval

- **A new group, `pointing check`,** with its own line and the usual threshold: Victor's 20
  English verdicts above, and 21 Italian sentences from his 2026-10-18 data (below), each asked
  of the production prompt and parser alone. Tier 1: the answer reads. Tier 2: the verdict
  matches. Labels start `point `, so `run.ts "point "` runs the group.
- **The Italian cases are labelled by me, under R1** (from the builder check: Victor validated the
  English verdicts, not these). Only clear-cut sentences are kept. The two that only narrow to a
  kind are the Italian twins of his verdicts 3 and 5. The ones I judged borderline ("Io ho una
  ___ con il tavolo.", "L'uccello è nel ___.", "Qui ci sono un ___ e fiori.") are left out.
  - **Point to nothing (14):** Io ho ___ ora. (tempo) · La ___ è qui. (porta) · Io ho una ___
    qui. (finestra) · Io ho un ___. (treno) · Il ___ è freddo. (cielo) · La ___ è vicino alla
    finestra. (sedia) · La città è ___. (grande) · Io ho un ___. (pesce) · Il ___ è qui. (treno)
    · Ho una ___ qui. (sedia) · Il ___ è qui. (cielo) · Io sono ___ ora. (felice) · Mio ___ è
    felice. (fratello) · Il ___ arriva ora. (treno)
  - **Point (7):** Ho poco ___ per il lavoro. (tempo) · Ho un ___ con sedie. (tavolo) · Il ___ è
    blu ora. (cielo) · Il ___ arriva in inverno. (freddo) · Un ___ vola nel cielo. (uccello) · Ci
    sono uccelli nel ___. (cielo) · Il ___ è nell'acqua. (pesce)
  - Over all 41 cases (23 no, 18 yes), a check that says no to everything scores 56% and one
    that says yes 44%: both fail the group.
- **The typed gap rows** (the `sentence` group's `sentence` cases) run production's rescue through
  the same domain functions: point check, one rewrite of what failed, validation, re-check. Every
  tier-2 check reads the sentence production would show. A card production would degrade fails
  exactly one check, a new one, "the point check passes the sentence shown" (my call, as 62c
  counts a lost card once), and the row's other checks read the last sentence written for it.
  The phase 41 probe stays as it is.
- **The list share is not loosened** (from the builder check). R2 lets a rewrite leave the list
  where pointing needs it, so a rescued sentence may fail the eval's 50% list share. That is the
  trade-off below, never a reason to change the check.
- **A new typed gap case** from Victor's own session: cielo, treno, porta, sedia, finestra, pesce,
  felice, grande, with the 20 learner words his 2026-10-18 21:37 session was sent, and each word's
  saved example and the avoid lists that session's request carried.
- **Acceptance:** the pointing group and the sentence group at or above the threshold in three
  local runs and in CI; tier 1 clean; the full report compared row by row with master's (memory
  `prompt-change-compare-master-report`). A trade-off the rescue makes (pointing passes, the list
  share drops) goes to Victor, never a loosened check: if it alone holds a group under the
  threshold, the PR opens with the evidence under **Left for Victor**.

### D7. Tests

- **Unit (`domain/`):** the point prompt is blind (no item carries the word) and carries its
  marker; parsing; the decision (not clear fails; the word first passes; a first guess of the
  same meaning passes; another word fails, with the guesses as feedback; generated alternatives
  never count); the point faults; the sentence rewrite rule present only when a sentence item is
  rewritten; today's batch and 62c's gap-rewrite prompts byte-identical; a rewritten sentence item
  valid at 12 words, a first-written one refused at 9.
- **Service (`sessions.prepare.test.ts`, fakes):** the point check started beside the context
  call; a gap fault and a typed fault in one session asked in two rewrite calls, each with only
  its own rule; a typed gap that fails rewritten, re-checked and kept; a rewrite that fails or a re-check
  that fails it degrading the card to a typed translation; a re-check that errors keeping the
  rewrite; a point check that errors keeping every typed gap; a question-types session dropping
  the card; the budgets and the expiry.

## Rulings

- **R1 (Victor, 2026-10-18).** The bar is the 20 verdicts above: the first guess, clearly, and
  narrowing to a kind fails ("Mio ___ è felice." is "not clear at all").
- **R2 (Victor).** Words outside the learner's list are allowed where pointing needs them: "that's
  the point of tap to translate". The learner's words come second.
- **R3 (Victor, play-back).** A typed gap that cannot be made clear becomes a typed translation,
  never an unclear gap. Only the typed gap card changes. A rewrite may use up to 12 words.

## Left to the builder

- The point prompt's exact wording, judged by the pointing group.
- The sentence rewrite rule's exact wording, within D3, judged by the sentence group.
- How the point check and the re-check slot into `prepareSession`'s existing `Promise.all`
  branches, and where the pure parts live in `domain/`.
