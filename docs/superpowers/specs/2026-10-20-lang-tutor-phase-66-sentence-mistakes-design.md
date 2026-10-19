# Phase 66 — Sentence mistakes, explained, not graded

- **Status:** Designed with Victor in chat on 2026-10-19/20. He said "go till PR" after reading the
  one-pager (CLAUDE.md, *Continue till PR*), so the questions left after it are answered here by me
  and marked **(my call)**. Lines marked **(Victor)** are his decisions.
- **Date:** 2026-10-20
- **Source:** `drafts/2026-10-20-sentence-mistakes-explain-one-pager.md` (main checkout, gitignored)
  and the chat before it.
- **Builds on:** phase 27 (the judged translation card), phase 34 (the second try), phase 45 (the
  translation judge's detail rule and thinking budget), phase 59 (the easier sentence, taps).
- **Touches:** the translation judge prompt and its eval cases; a new explain prompt, endpoint,
  table and eval group; the app's sentence-translation card; e2e.

---

## Goal

Victor translates a Hebrew sentence into Italian and gets the practised word right, but makes other
mistakes, because the app teaches no grammar and his vocabulary is small. Today the judge counts
any changed detail as "meaning not conveyed", so a right word can be graded wrong; and when small
slips are forgiven, the card says "correct" and reads the reference aloud without saying what
differed. Either way nothing explains his sentence. That is frustrating and demotivating.

**(Victor)** The word's grade asks only about the practised word. Mistakes in the rest of the
sentence are information for the learner, shown and explained on request, and cost nothing: not
the word's grade, not its memory, not readiness. Reason: the app has no grammar teaching yet and no
idea of the learner's expected grammar level.

**Done means:**

1. A sentence whose practised word is right is never graded wrong for mistakes elsewhere in it.
2. After answering, Victor can tap **הסבר** and see each mistake in his sentence, its fix and why.
3. `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and the prompt evals pass.

## Non-goals

- Grading grammar or the sentence as a whole; any effect on readiness or memory **(Victor)**.
- Counting a mistake on another saved word as a miss on that word **(Victor)**.
- Grammar lessons or notes beyond one line per mistake **(Victor)**.
- Explanations on any other card (typed meaning, cloze, dictation).
- The bots and the day simulation, which never ask for an explanation.

**Anti-goal:** the explanation must never slow the grade or block "continue". The card works
exactly as today when the explanation is late or fails.

---

## D1. The judge grades the practised word only

`buildTranslationJudgePrompt` (`domain/judge.ts`) is rewritten around the word:

- **right:** the practised word is in the answer, in the sense of `meaning`, in a form the Hebrew
  sentence needs (tense, person, number, gender). Everything else in the answer is ignored: other
  words, their grammar, details changed or left out.
- **misspelled:** as right, with a one-letter or accent slip in the practised word itself.
- **other_word:** another word stands where the practised word should, one that means the same
  there. It keeps the one second try (phase 34) as today.
- **wrong:** the practised word is missing, in another sense, or in a form the sentence does not
  need; or the answer is not an attempt at this sentence.

Phase 45's detail rule ("any other detail changed or left out means not conveyed") goes: it is the
rule Victor's ruling removes. The verdict set, the parser, the thinking budget, the rules in
`translationRuleVerdict` (empty and word-only are wrong, the reference as typed is exact) and the
whole grading path after the verdict stay as they are. **(my call)** Typing only the practised word
stays wrong: the card asks for a sentence, and phase 59's taps cover the words out of reach.

**Eval cases change with the rule, by Victor's ruling, not to pass.** In `TRANSLATION_JUDGE_CASES`:
"missed meaning" with the word right (`prenotare una camera per tre`, `book a table for four`) and
"manner word left out" with the word right (`Он бегает.`) become `exact`; "manner word left out"
with another word (`talk with everyone`) becomes `alternative`. Cases whose word is missing or
wrong stay `wrong`. New cases **(my call)**: the word right in a sentence with several grammar
mistakes (`exact`, it, ru, en); the word right in the wrong person or tense the Hebrew needs
(`wrong`).

## D2. Explaining the sentence: a second call, stored

A new model call, separate from the judge so the grade stays as fast as today and the anti-goal
holds (memory: optional extras in a judge schema made Gemini calls hang).

**Prompt** (`domain/explain.ts`, pure, beside `judge.ts`): the Hebrew sentence, the reference
translation (one good translation, not the only one), the practised word and its meaning, and the
learner's answer. The model lists what is wrong in the answer as a translation of the Hebrew
sentence: grammar, wrong or missing words, changed meaning, spelling. A different but valid
wording is not a mistake. Each mistake explained in one short line in the learner's language
(Hebrew), naming the rule when there is one.

**Response schema** (required fields only, no optional strings):

```
{ corrected: string,            // the learner's own sentence, minimally fixed
  mistakes: [ { wrong: string,  // the words as the learner wrote them ("" when something is missing)
                right: string,  // what they should be
                why: string } ] }  // one line, Hebrew
```

At most 6 mistakes **(my call)**; no mistakes means the sentence is right.

**Endpoint** `POST /api/sessions/{id}/explain`, body `{ question_id }`. The answer is read from the
record, never sent again: the explanation is of what was graded.

- Authorized as every session use case (ADR 0009 R7). 404 for no session; 400 when the card is not
  a sentence translation or has no typed answer yet; 409 while its second try is pending.
- The text explained is the card's final one: the retry's when there was one, else the answer's.
- A text that is empty, or the reference as typed (`normaliseTyped`), returns no mistakes without a
  call.
- A stored explanation is returned as is, with no call (replay).
- Otherwise: read in one transaction, call the model outside it (ADR 0001 R8), store in a second
  (`ON CONFLICT DO NOTHING`, then read back, so two overlapping requests return one explanation),
  and return `{ corrected, mistakes }`.
- An unreadable or failed call is 502, nothing stored; the app may ask again.

**Its client** `explainer` in `composition.ts`: the judge's timeout, its own thinking budget, set
by measuring in the eval (builder's call, start from the translation judge's 512). Recorded in
`model_calls` with kind `sentence_explain`.

**Table** `answer_explanations` (migration 0047, R5) **(my call: recorded, per Victor's
derive-then-record preference)**: `session_id`, `position` (the PK, and a cascading FK to
`answers`), `text` (the text explained), `corrected`, `mistakes` jsonb, `created_at`. Never read by
grading, memory, readiness or the recompute.

**Eval group** `explain `: per language (it, ru, en), a sentence with known mistakes (each case
names a fix that must appear in some `right` or in `corrected`), a valid paraphrase (no mistakes),
and every `why` in Hebrew script. Tier 1 as every group: the call returns and parses within its
timeout.

## D3. The card: a הסבר button

On a sentence-translation card, once it is answered (final verdict, not a pending second try), the
reference block gets a small **הסבר** button next to the speak button, when the learner's final
text is non-empty and is not the reference as typed (`normaliseTyped`) **(Victor)**.

- The request starts as soon as the button appears, without waiting for a tap **(Victor)**: a
  component mounted with the reference block, holding its own state. Leaving the card drops the
  result; the server has stored it anyway.
- A tap opens a panel under the reference **(Victor)**:
  - ready, with mistakes: "המשפט שלך, מתוקן:" with `corrected`, then one row per mistake,
    `wrong → right` and `why` under it;
  - ready, none: "המשפט שלך נכון";
  - not yet: a short loading line, "מכין הסבר…", replaced when it lands;
  - failed: "ההסבר לא זמין כרגע". **(my call)** No retry button.
- A second tap closes it. The banner, its tone, the verdict, the speak buttons and "continue" are
  unchanged.
- Hebrew strings in `strings.ts`; the RTL layout keeps Italian runs as their own `Text`, like the
  reference.

No `API_LEVEL` bump: the endpoint is new and the judge's response is unchanged, so an older app
just never asks.

## Tests

- **Unit (server):** the explain prompt carries the four inputs; the parser reads a good response,
  refuses a bad one and caps at six; the judge prompt no longer holds the detail rule.
- **Integration:** the endpoint's rule paths (no call for the reference or an empty text), a model
  path through MockServer storing one row, a replay with no call, the retry's text after a second
  try, 409 on a pending retry, 400 on another card type, 403 for another learner's session, 502 on
  a failed call with nothing stored.
- **Unit (app):** when the button shows; the panel's four states.
- **e2e:** a translation card answered with a mistake shows הסבר; the tap shows the mistake. The
  MockServer stub for the explain call is matched by its marker, like the judge's.
- **Evals:** the changed and new judge cases; the `explain ` group, run at least twice.

## Left to the builder

The explain prompt's wording and thinking budget (measured), names inside the app component, and
the panel's styling within the phase 64 look (white card, one blue).

## Rulings made while building

Ruling: R1. The judge's wrong verdict names "the practised word alone, with no sentence around it" as
not a sentence. Without the detail rule a bare `красивый` was judged right in both eval runs. A first
wording, "a word or two", could grade a correct two-word sentence wrong (review); the case `Egli
corre.` now guards it. The app's `wordOnly` rule refuses the word alone before any call anyway.

Ruling: R2. `EXPLAIN_THINKING` is 1024. At 512 the explainer called the Russian short form `красив` a
mistake in both runs; at 1024 the `explain ` group passed 21/21 twice, about 3.5 s a call, which
nothing waits on.

Ruling: R3. The explain prompt compares the answer with the Hebrew sentence, not the reference, and
names what is not a mistake (another correct wording, form or order, a word that only makes the
sentence's meaning explicit): without it, `per due persone` and `for two people` were flagged.

Ruling: R4. The הסבר button sits under the reference row, not beside the round speak button, so a
long Italian line keeps its width on a phone. A mistake's Hebrew reason opens with U+200F, because
Android takes a line's direction from its first strong letter and `writingDirection` is iOS-only.

Ruling: R5. Phase 65b took migration 0046 on master while this was built; this table is 0047.

