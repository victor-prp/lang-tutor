# Phase 45 — Another accepted word on the second try is not "right", and a dropped detail is not conveyed

- **Status:** Victor tested phase 42 on 2026-10-13, found the bug below on a sentence translation
  card, numbered it phase 45 and said "go till the end": the design is self-approved (CLAUDE.md,
  *Continue till PR*). Rulings are at the end.
  Implemented on branch `phase-45-second-try-other-word`. Building changed D2: the prompt wording
  alone did not fix the judge. Three tightened prompts all still called *talk with everyone*
  `other_word`, every run; with thinking on (512 tokens) the first prompt called it `wrong` every
  run. So the translation judge got its own client with thinking (D3), at a median 2.4 s a call
  against 0.6 s. Measured: translation judge tier 2 32/32 in three runs, up from 25/27 on master.
- **Date:** 2026-10-13
- **Builds on:** phase 34 D9 (one second try after another accepted word), phase 42 D1 (a second
  try's banner says what that try was), phase 27 D4 (the translation judge).
- **Touches:** `feedbackFor` and the feedback banner in the app, one string pair; the translation
  judge's prompt, its own model client (D3) and its eval cases. No wire change, no migration, no
  `API_LEVEL` change.

---

## The bug

Lane 0, question `642bf037…` (`sentence_translation`, *communicate*; Hebrew חשוב לתקשר בבירור עם
כולם.; reference *It is important to communicate clearly with everyone.*):

| | typed | verdict |
|---|---|---|
| first answer | *it's important to talk with everyone* | `alternative` (judge: `other_word`), second try opened |
| second try | *it's imorant to discuss it with everyone* | `alternative` again |

The app then said **נכון! המילה שתרגלנו: communicate**, green. The retry notice had asked for
another word; the second try did not use it, and was told "right". Two causes:

1. **The banner.** Phase 42 kept a second try's own banner when it is another accepted word, and
   that banner is the first answer's "right". On a second try it means the learner missed what
   the try asked for. Score and memory are not the issue: the first answer counts, and an
   `alternative` second try moves nothing (`evidenceVerdict`).
2. **The judge.** Both answers dropped **בבירור** (*clearly*). The translation prompt says a changed
   detail means the sentence is not conveyed, and lists "a number, a person, a tense, an object, a
   quality"; a manner word left out was not read as one, so the first answer should have been
   `wrong` and opened no second try.

## Goal

**Done means:**

1. A second try that is another accepted word again shows a banner of its own, neither green nor
   red: **עדיין לא המילה שתרגלנו:** and the practised word (**עדיין לא הפירוש שתרגלנו:** and the
   meaning, on a meaning card), its input not coloured.
2. The translation judge calls a translation that leaves out or changes a manner or degree word
   (*clearly*, *quickly*, *very*) `wrong`.

`npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass, and
`TIER2_THRESHOLD` is not lowered.

## Scope

**In:** the banner of another accepted word on a second try (D1); the translation judge's details
(D2).

**Out:** score and memory (R2); the meaning judge; a first answer's banners.

---

## 1. Decisions

### D1. A third banner tone, for "still not the word"

`Feedback.tone` gains `'other'`. `feedbackFor(question, answer, retry)` with a hold, when the second
try's own banner would be another accepted word (verdict `alternative`), returns:

`{ tone: 'other', title: strings.feedbackStillOther | strings.feedbackStillOtherSense, line: <the
practised word or meaning>, verdict: null }`

- the title is the meaning one on a `typed_meaning` card, the word one elsewhere;
- the line is what the first-answer banner names: the practised word (a translation's `answer`,
  not its sentence), or the meaning;
- `verdict: null` leaves the input uncoloured: it is neither the right word nor wrong.

The banner draws the `other` tone on the plain surface with a border, its title in the text
colour, testID `feedback-other`. Every other banner is unchanged, phase 42's included: a repeat
of the first answer and a give-up keep the first answer's banner.

### D2. A left-out or changed manner word is a changed detail

`buildTranslationJudgePrompt`'s detail sentence becomes: any other detail of the sentence changed
or left out (a number, a person, a tense, an object, a quality, or how something is done, such as
*clearly*, *quickly* or *very*) means it is not conveyed. The marker, schema and verdicts are
unchanged, so no stub changes.

### D3. The translation judge thinks before it answers

The judge client runs with thinking off (phase 27 D4: the learner waits). For the translation judge
that is what failed: comparing every detail of two sentences needs the model to reason first. It
gets a client of its own, `translationJudge`, with `TRANSLATION_JUDGE_THINKING` = 512 tokens
(`domain/judge.ts`), built in `composition.ts` beside `judge` with the same timeout. Measured on
lane 0's card, three rounds:

| thinking | median | max | *talk with everyone* |
|---|---|---|---|
| 0 | 0.58 s | 0.80 s | `other_word` 3/3 |
| 128 | 1.22 s | 1.31 s | `other_word` 3/3 |
| 512 | 2.38 s | 2.58 s | `wrong` 3/3 |

2.6 s is inside the server's 8 s judge budget and the app's 15 s. The meaning judge and the fit
judge keep thinking off: their eval groups are at 100%, and they wait on shorter inputs.

## 2. Changes

- `apps/mobile/src/feedback.ts`: the `other` tone and its case in `feedbackFor`.
- `apps/mobile/src/strings.ts`: `feedbackStillOther`, `feedbackStillOtherSense`.
- `apps/mobile/src/components/FeedbackBanner.tsx`: the third tone.
- `apps/server/src/domain/judge.ts`: D2's sentence, `TRANSLATION_JUDGE_THINKING`; `judge.test.ts`.
- `apps/server/src/composition.ts`, `services/sessions.ts`: the `translationJudge` client, used for
  a `sentence_translation` card (D3); `sessions.judge.test.ts`.
- `apps/server/tests/eval/cases.ts`: the *communicate* cases.
- `e2e/tests/sentence-cards.spec.ts`: a translation's second try with another word again.

## 3. Testing

- **Unit (mobile):** another accepted word on a second try gives the `other` banner on a typed,
  cloze, say, translation and meaning card; a first answer that is another accepted word, a repeat
  and a give-up are unchanged; right and wrong second tries unchanged.
- **Unit (server):** the translation prompt names a manner word left out.
- **E2E:** a translation answered with another word twice (judge stub `other_word` twice): the
  retry notice, then `feedback-other` with **עדיין לא המילה שתרגלנו:** and the practised word.
- **Eval (translation judge group, tier 2):** for *communicate* (חשוב לתקשר בבירור עם כולם.):
  *It is important to talk with everyone.* → `wrong` (clearly left out); *It's important to
  communicate clearly with everyone.* → `exact`; *It is important to talk clearly with everyone.*
  → `alternative` (another word, every detail kept); a held-out case on a word the prompt does not
  name: *Он быстро бегает* (הוא רץ מהר) answered *Он бегает* → `wrong`.

## 4. Rulings

- **R1.** A third tone rather than red: another accepted word is a right translation, so red would
  be its own lie; green said "right" to a try that missed its point.
- **R2.** Score and memory unchanged, as phase 42 R2.
- **R3.** The input is uncoloured (`verdict: null`): its green border was the other half of
  "right".
- **R5.** Thinking for the translation judge only (D3): it is the one whose eval failed, and each
  judge's wait is paid only where it buys a right verdict. Switch signal: the meaning judge's group
  drops below 100%.
- **R4.** The prompt's manner examples are general words (*clearly*, *quickly*, *very*); the eval's
  held-out case checks the rule beyond them.
