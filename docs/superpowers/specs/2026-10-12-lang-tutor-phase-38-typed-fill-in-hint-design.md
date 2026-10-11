# Phase 38 — The typed fill-in card hides its Hebrew sentence

- **Status:** Victor scoped it in the one-pager on 2026-10-12, chose option 3 (hide the Hebrew
  sentence behind a hint), added "a word that fits gets 'it works, but we meant…'", chose a retry
  over showing the answer, then said "go til PR": the questions the one-pager parked are
  answered here with recommendations, and the design is self-approved (CLAUDE.md, *Continue till
  PR*). Rulings are at the end.
- **Date:** 2026-10-12
- **Source:** `drafts/2026-10-12-typed-fill-in-hint-one-pager.md` (gitignored; restated below).
- **Builds on:** phase 27 D5 (`cloze_typed`: a new sentence, its gap, its Hebrew), phase 34 D8
  (the Hebrew marks the practised word) and D9 (one second try after a right answer that is not
  the saved word).
- **Touches:** the `sentence` task's prompt and alternatives cap; one optional request field;
  one nullable column (migration 0029); the typed fill-in card, its retry notice and two
  strings in the app. No new model call, no new secret, no `API_LEVEL` change.

---

## Goal

The typed fill-in card (`cloze_typed`) shows a new sentence with a gap and the whole sentence in
Hebrew under it. The learner reads the Hebrew, finds the word and translates it; the sentence in
the language being learned is never needed. That is sentence translation with one word to type,
and the two cards test the same thing.

After this phase the card opens with the sentence and its gap only. The Hebrew sentence is a
hint: one tap shows it, and it always shows after the answer. A word that fits the gap but is
not the one meant is right, says so, opens the hint, and gets one more try.

**Done means**, Victor's outcomes from the one-pager:

1. The typed fill-in card opens without the Hebrew sentence. One tap shows it, and it always
   shows after the answer.
2. Every answer records whether the hint was opened, so we can see if the card is answered
   without it (D4 gives the query).
3. After using it for a while, the card no longer feels like the same question as sentence
   translation. Victor's judgement, not a number.
4. A word that fits the gap but is not the one meant opens the Hebrew sentence with "it works,
   but we meant…", and the learner retries with it showing.

Items 1, 2 and 4 are checked by automated tests (§3). `npm test`, `npm run test:all`,
`npm run lint:arch`, `npm run e2e` and `npm run eval` pass, and `TIER2_THRESHOLD` is not lowered.

## Scope

**In:**
- the Hebrew sentence of the typed fill-in card behind a hint, shown on tap, during a retry and
  after the answer (D1);
- words that fit the sentence read alone accepted as `alternative` (D2);
- the card's own retry wording (D3);
- recording, per first answer, whether the hint was opened (D4).

**Out** (one-pager):
- changes to other cards: sentence translation, the pick-from-four fill-in (`cloze_choice`,
  which already hides its Hebrew), typed translation;
- any cost for opening the hint: grading and memory are unchanged, and the count decides later;
- a lighter hint showing only the word's Hebrew meaning;
- more than one retry.

---

## 1. Decisions

### D1. The card

Before the answer the card shows its instruction (**השלימו את המילה החסרה ב…**, unchanged), the
sentence with its gap, and under it a button, **רמז: הצגת המשפט בעברית** ("Hint: show the
sentence in Hebrew"). Tapping it replaces the button with the Hebrew line, the practised word
marked as phase 34 D8 has it. The Hebrew line shows, and the button does not, when any of these
holds:

- the hint was opened on this card;
- a second try is pending (D3), on a resumed session too;
- the card is answered, whatever the verdict.

`showsSentenceTranslation` in `apps/mobile/src/sentence.ts` decides it, so it is unit-tested;
`cloze_choice` keeps its rule (only once answered). The open state belongs to the card: a new card
starts closed.

### D2. What "fits" means, and who decides

The `sentence` task's alternatives become every other word that fills the gap **with the sentence
read on its own, without its translation**, in the form the gap needs, the likeliest first, at
most 10. Today's prompt asks for words that fit "given that translation", at most 5, which was
right while the Hebrew was on screen and is too narrow now: in *We ___ too much money on the trip
last summer*, `wasted` fits and today is wrong.

The judge does not change. `judgeTyped` already returns `alternative` for a listed word, on the
phone and again on the server, and phase 34 already holds the card for its retry on that
verdict. The cap is `MAX_CARD_ALTERNATIVES` (10), which the `questions_type_valid` constraint
already allows for `cloze_typed`, so no migration touches `questions`.

Approaches weighed:
1. **A wider list at preparation (chosen).** No wait and no cost per answer; one rule on both
   sides. A fitting word the list missed is still wrong.
2. **A model call on a wrong answer**, while the learner waits, as typed meaning has. It covers
   every fit, but every wrong answer on the card would wait for the model and cost a call, and
   the card would need the judged path beside the phone's.
3. **Both.** The cost of 2 for the tail 1 misses.

Switch signal for 2: Victor finds fitting words marked wrong.

### D3. The message

A `cloze_typed` card held for its second try shows phase 34's notice with its own second line:

> ✓ נכון, ⁨*answer*⁩ מתאים כאן.
> אבל התכוונו למילה אחרת — היעזרו במשפט בעברית ונסו שוב

("Right, *answer* fits here. But we meant another word: use the Hebrew sentence and try
again.") The Hebrew line is open under the sentence (D1). Everything else is phase 34 D9: the
input cleared, **הצגת התשובה** gives up, one retry, the first answer counts as right in the
score, and a right retry moves the word as its verdict would.

The app picks the line by the card's type, which it has. `PendingRetry.wording` stays
`'word' | 'meaning'`: a new enum value would break the parse of every app build that predates
it (ADR 0012).

### D4. Counting the hint

- **Wire.** The `text` form of `NextStepRequestSchema` gains `hint_opened: boolean`, optional.
  The app sends it on a first answer to a `cloze_typed` card, `show the answer` included, and
  never on a retry.
- **Stored.** `answers.hint_opened boolean`, nullable, migration 0029. It is set on the first
  answer of a `cloze_typed` card from the request, and null for every other card, for an
  older app that does not send it, and for a replay. A retry leaves it as the first answer
  stored it. Constraint `answers_hint_opened_typed`: `hint_opened is null or typed_text is not
  null`.
- **The opened-by-retry case is not counted:** the hint a retry opens is the app's doing, and the
  field is only read on a first answer.
- **Compatibility.** An optional request field breaks no older app, so `API_LEVEL` stays
  (ADR 0012's rule names a *required* field). An older app keeps showing the Hebrew, and its
  answers store null.
- **The query** done item 2 reads:

  ```sql
  SELECT a.hint_opened, count(*)
  FROM answers a JOIN questions q ON q.id = a.question_id
  WHERE q.type = 'cloze_typed'
  GROUP BY a.hint_opened;
  ```

## 2. Changes

- `packages/core/src/api/schemas.ts`: `hint_opened` on the text request; the next-step route's
  description names it.
- `apps/server/src/domain/distractors.ts`: the `sentence` task's prompt line (D2).
  `apps/server/src/domain/sentences.ts`: alternatives capped at `MAX_CARD_ALTERNATIVES`.
- `apps/server/src/db/schema.ts` + `migrations/0029_*.sql`: the column and its constraint.
- `apps/server/src/repo/sessions.ts` `insertAnswer`: takes `hintOpened`.
  `apps/server/src/services/sessions.ts` `submitAnswer`: passes it for a first `cloze_typed`
  answer, null otherwise. `apps/server/src/routes/sessions.ts`: reads it from the body.
- `apps/mobile/src/sentence.ts`: `showsSentenceTranslation` (D1). `strings.ts`: the hint button
  and the retry line. `feedback.ts` `retryNotice`: takes the question type. `quiz.ts`
  `nextStepRequest` and `hooks/useSession.tsx` `submitText`: carry `hint_opened`.
  `app/session.tsx`: the typed fill-in card holds its hint state and renders the button.
- `e2e/tests/support/cards.ts`: the generation stub can give the sentence task alternatives.

## 3. Testing

- **Unit (mobile):** `showsSentenceTranslation` for each case of D1 and for `cloze_choice`;
  `retryNotice` wording for `cloze_typed` and the others; `nextStepRequest` with and without
  `hint_opened`, and never with it on a retry.
- **Unit (server):** the `sentence` prompt line asks for words that fit the sentence read alone,
  at most 10; `validateSentenceItem` keeps up to 10 alternatives.
- **Unit (core):** the request schema accepts `hint_opened` on text and refuses it as a
  non-boolean.
- **Integration:** a first `cloze_typed` answer stores `hint_opened` true and false as sent;
  absent stores null; a typed translation's stays null even if sent; a retry keeps the first
  answer's value; the migration adds the column and its constraint.
- **E2E** (`sentence-cards.spec.ts`): the typed fill-in card shows no Hebrew line and a hint
  button; tapping it shows the line with its mark; the answer still works. A new case: the
  sentence stub lists an alternative, answering it shows the retry notice with D3's line and
  the Hebrew line open without a tap, and the saved word on the retry is right.
- **Eval:** the `sentence` cases gain a tier 2 check per item, that it lists at least one other
  word that fits the gap: every case sentence is everyday and admits one.

## 4. Rulings

- **R1.** D2's list over a judge on a wrong answer: no wait, no cost per answer, no second
  judging path. Switch signal in D2.
- **R2.** Phase 34's first line kept and the second replaced, so the two retries read as one
  family and the learner is told why the hint opened.
- **R3.** The hint label names what it shows ("the sentence in Hebrew"), so tapping it is a
  known trade, not a mystery.
- **R4.** `hint_opened` only on the first answer of the one card that has a hint: a column true
  or false for all cards would count a hint that does not exist.
- **R5.** The alternatives are not passed through phase 34's checker. A listed word that does
  not truly fit costs one undeserved "right" and a retry with the hint; the checker would cost
  a field and a prompt change for that.
- **R6.** No `API_LEVEL` raise: one optional request field, no response change.
