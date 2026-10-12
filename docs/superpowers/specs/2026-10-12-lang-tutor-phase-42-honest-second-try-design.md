# Phase 42 — A second try's banner says what that try was, and "another sense" is a real sense

- **Status:** Victor tested phase 41 on 2026-10-12, found the bug below, agreed to "the banner after
  a second try should describe that try, not the first answer", asked for the judge fix with it,
  and said "go till PR": the design is self-approved (CLAUDE.md, *Continue till PR*). Rulings are
  at the end.
- **Date:** 2026-10-12
- **Builds on:** phase 34 D9 and ruling R16 (one second try; a given-up or wrong second try shows
  the first answer's banner), phase 27 D4 (the meaning judge's three verdicts).
- **Touches:** `feedbackFor` in the app and its tests; one e2e case; the meaning judge's prompt
  and its eval cases. No server logic, no wire change, no migration, no `API_LEVEL` change.

---

## The bug

Lane 0, question `b51d6560…` (`typed_meaning`, *imagination*, saved meaning דמיון, card sentence
*Her imagination helps her write stories.*):

| | typed | verdict |
|---|---|---|
| first answer | הזייה | `alternative`: the judge said `other_sense` |
| second try | יצירתיות | `wrong` |

Then the app said **נכון, אבל כאן תרגלנו: דמיון** ("Right, but here we practised: דמיון") under
יצירתיות, its input not coloured. The learner reads that יצירתיות was accepted as another sense.
Two causes:

1. **The banner.** `feedbackFor` (`apps/mobile/src/feedback.ts`) replaces any wrong second try's
   banner with the first answer's (ruling R16). That is honest for "show the answer", which typed
   nothing; for a typed second try it shows the opposite of the verdict.
2. **The judge.** "imagination" has one sense in the dictionary; הזייה (hallucination) is a nearby
   idea, not a sense of the word. The prompt's `other_sense` line ("a correct meaning of the word,
   but of a different sense") gives no boundary between another sense and a related word, so the
   second try should never have opened.

## Goal

**Done means:**

1. A wrong typed second try shows **התשובה הנכונה:** with the saved word or meaning, its input
   marked wrong, like any wrong answer.
2. A given-up second try ("show the answer", or a spoken card's pass) keeps today's banner: the
   first answer counted, and the saved word is named.
3. The meaning judge calls הזייה and יצירתיות for *imagination* `wrong`, and keeps a real second
   sense (*bank* → גדה) `other_sense`.

`npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e` and `npm run eval` pass, and
`TIER2_THRESHOLD` is not lowered.

## Scope

**In:** the banner of a second try (D1); the meaning judge's `other_sense` boundary (D2).

**Out:** the score and memory of a card with a second try (R2); the translation judge's
`other_word`, which bug 2 did not touch; the retry notice before a second try.

---

## 1. Decisions

### D1. The banner after a second try

`feedbackFor(question, answer, retry)` with a hold (`retry !== null`):

| the second try | banner |
|---|---|
| right (`exact`, `near_miss`, `understood`) | its own, as today |
| another accepted word (`alternative`) | its own, as today: "right, the word we practised: …" |
| **given up**: an empty text, or a `pass` | the first answer's, as today (R16) |
| **wrong**: a non-empty text | **its own: `tone: 'wrong'`, התשובה הנכונה:, the saved word or meaning** |

A judged card's given-up second try comes back from the server as `judged: 'wrong'` with an empty
text (phase 34 ruling R15), so "given up" is decided by the text being empty, on every card.

The `verdict` the card's input is coloured by is the banner's, so the wrong second try's input is
marked wrong with no other change. On the results screen the card still counts as right (R2).

### D2. "Another sense" is a sense the word really has

`buildMeaningJudgePrompt`'s `other_sense` line becomes: the answer is a meaning the word really has
in another context, one a dictionary would list as a sense of its own (for example *bank* → גדת
נהר while practising בנק). Its `wrong` line gains: a word that is only related, associated or near
in meaning is wrong even when close (for example *imagination* → הזייה or יצירתיות). The marker,
the schema and the three verdicts are unchanged, so no stub changes.

## 2. Changes

- `apps/mobile/src/feedback.ts`: `feedbackFor`, and its comment.
- `apps/mobile/src/feedback.test.ts`: the wrong second try's case flips; given up stays.
- `e2e/tests/ambiguous-questions.spec.ts`: a wrong typed second try shows the red banner, and the
  score still counts the card.
- `apps/server/src/domain/judge.ts`: D2's two lines; `judge.test.ts`.
- `apps/server/tests/eval/cases.ts`: *imagination* cases.

## 3. Testing

- **Unit (mobile):** a wrong typed second try on a typed, typed-cloze, say-the-translation (typed),
  sentence-translation and meaning card has `tone: 'wrong'`, `feedbackWrong` and the right answer;
  every given-up form keeps the first answer's banner; right and alternative second tries unchanged.
- **Unit (server):** the meaning prompt carries the dictionary-sense wording and the "related is
  wrong" wording.
- **E2E:** a typed card, its alternative, then a wrong word: `feedback-wrong`, התשובה הנכונה: and
  the saved word; the results score still counts the card.
- **Eval (tier 2, judge group):** *imagination* (דמיון, *Her imagination helps her write
  stories.*): הזייה → `wrong`, יצירתיות → `wrong`, דמיון → `exact`; the existing `other_sense`
  cases (בנק/גדה, ספר, מפה, מחנה, קשת, מעיין) stay green.

## 4. Rulings

- **R1.** Given up is an empty text, not a verdict: the server reports a judged give-up as `wrong`,
  and a typed one as `gave_up` the app never sees.
- **R2.** The score and memory are not changed: the first answer was accepted and counts, and a
  second try moves memory only when right (`evidenceVerdict`). A results screen counting a card
  whose last banner was red is the accepted cost; changing what a second try scores is grading,
  a phase of its own.
- **R3.** No list of the word's senses goes to the judge: the dictionary holds the senses saved,
  not every sense, so a word with one stored sense may still have others.
- **R4.** Phase 34's ruling R16 is narrowed, not reversed: it stays for a given-up second try.
