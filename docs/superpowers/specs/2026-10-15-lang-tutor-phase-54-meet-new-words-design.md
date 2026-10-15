# Phase 54 — Meet a new word before it is asked, and practise it in its first session

- **Status:** Victor said "Go till PR, subagents" on 2026-10-15 after approving the one-pager
  in chat: the design is self-approved (CLAUDE.md, *Continue till PR*). Rulings are at the end.
- **Date:** 2026-10-15
- **Source:** `drafts/2026-10-15-new-word-introduction-one-pager.md` (main checkout), and the
  chat that led to it; the research behind it is `drafts/reports/opus-medium - New word initial
  encoding.md` (the stronger of the two reports) and
  `drafts/reports/gemini_vocabulary_encoding_research_report.md`.
- **Builds on:** phase 35 / 37 (the picker, the card plan, the day state), phase 39 (families,
  `new_meaning`), phase 43 (the session in stock), phase 48 (a refused card is dropped),
  phase 53 (targets, pools), ADR 0011 (the gloss), ADR 0012 (`API_LEVEL`).
- **Touches:** the picker (`choose.ts`, `chooseConstants.ts`), the card plan (`plan.ts`), the
  prepare job and score in `services/sessions.ts` and `core/domain/quiz.ts`, the wire contract
  (a new question type and answer kind), one migration (two check constraints), the app's
  session screen and a new card view, the bots, and the day simulation.

---

## Goal

Victor added 30 Italian words to a homework target and was asked words he had never seen,
with no introduction, and every session brought more. Today a new word's first card is a
multiple choice — a guess — and the picker fills a session with new words up to the daily
cap. The research is clear on the first part: guessing an unseen, unrelated word does not help
it stick and can hurt cued recall (Seabrooke et al. 2019); study first, then retrieve it
several times, spaced, with the right answer shown after a miss (Karpicke & Roediger 2008,
Pashler et al. 2005, Latimier et al. 2021).

This phase makes a new word's first session a **ladder**: a meet card that shows it, then three
practice cards spread through the session. A ladder costs a session three slots, and a session
holds at most three ladders.

**Done means** (Victor):

1. Good tests prove it works as designed: the day simulation shows every new word met before it
   is asked and practised three times, never back to back, and no session with more than three
   new words, on the main path and in a thirty-word target; unit tests pin each rule below.
2. Victor imports a homework list, practises it for a few days, and it no longer feels
   overwhelming: he meets each word before he is asked it. (Left for Victor: it needs the
   release.)

`npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:** the meet card (D1); which words get a ladder (D2); the ladder's cards (D3); a ladder's
slots and the session's cap on new words (D4); where a ladder's cards sit in a session (D5); the
wire, the app and storage (D6, D7); the bots (D8).

**Out** (the one-pager's list):
- Requeueing a missed word later in the same session.
- Target pacing and a "this is a lot" warning on the target screen.
- "I already know it" on the meet card.
- A cap on words in progress across sessions.
- Images and an example sentence on the meet card.
- Guess-first cards for cognates; mnemonics for words that keep failing.
- A meet card for a new meaning of a known word: `new_meaning` keeps its card (assumed in the
  one-pager, kept).
- Measuring next-day recall against the old flow.

---

## 1. Decisions

### D1. The meet card

A new question type, `meet`. It shows:

- the title **מילה חדשה**;
- the word, large: the pick's form (as `read_aloud` shows it);
- a play button; the word is spoken when the card opens, as every card that shows the target
  word speaks it (phase 44), and again on a tap;
- the line **אמרו את המילה בקול** under the play button — a prompt, nothing is recorded;
- its Hebrew meaning: the rendering's translation, the sense that was saved, nothing more;
- one button, **המשך**.

No example sentence, no alternatives, no other senses (research: one sentence adds little to a
translation pair, and Hebrew speakers kept words better in isolation; Webb 2007, Laufer &
Shmueli 1997). The meet card is **ungraded**: it writes no memory, no progress and no score.
Answering it — the learner tapping **המשך** — records a `seen` answer (D6), which is what
dates the word's introduction (phase 35's `findIntroducedOn` reads a gloss's first answer).
There is no feedback banner; the app moves to the next card.

### D2. Which words get a ladder

A saved gloss is **unlearned** when it has no memory row, or when every memory row it has
records only Agains (`lapses === reps` on each): every answer about it so far was wrong
(Victor: words met but never answered right are treated as new). A matching board's right
answer grades Hard, and a typed near miss grades written receptive Good: both count as right.

The picker classes every unlearned gloss `NEW` (today only a gloss with no memory is), with two
exceptions that keep today's rule:

- a gloss **done** today (answered today and owing no return, or its returns spent) stays
  `DONE`;
- a family's new meaning that `glossFamilies` introduces with its known meanings (phase 39 D6)
  stays a single `new_meaning` card, not a ladder (Out).

An unlearned gloss **owed a return** is `NEW`, not `STEP`: a word missed in its ladder comes
back later in the day as a ladder again, never as a cold recall card. Its answers there count
as that return in `dayState`, as any answer in a later session does, so it comes back at most
`RETURNS_PER_DAY` times a day.

The picker reads this from the memory rows it is already given (`reps`, `lapses`); no new
query. It is also given the glosses `glossFamilies` introduces (`ChoiceInput.families` gains
`introductions`), so it knows which `NEW` picks are ladders. A gloss laddered again counts
toward the session's ceiling (D4) and the session's own new-word count as any `NEW` pick does;
`findIntroducedOn` counts its first introduction only.

### D3. The ladder

A ladder is one pick (one gloss, `cls: 'NEW'`, written receptive, `ladder: true` on
`ChosenPick`, the stored pick and `PlanPick`) that the card plan turns into four cards, always
in this order:

| # | Card | Type | Skill it grades | Why |
|---|---|---|---|---|
| M | Meet | `meet` | — | study first |
| P1 | Italian → choose the Hebrew | `multiple_choice` | written receptive | recognition first, high early success |
| P2 | Hebrew → choose the Italian | `reverse_choice` | written receptive Good, written productive Hard | the productive direction, still recognition |
| P3 | Hebrew → type the Italian | `typed_translation` | written receptive, written productive, spelling | unassisted recall; Italian spelling needs practice |

All three practice types are always eligible, so every ladder has all four. They are graded,
recorded and remembered exactly as the same types are today; the memory model already treats a
second review on the same day as short-term (`review` with t = 0), so three answers in one
session do not inflate stability. Ladder cards do not count toward `MAX_PER_TYPE`, and a
ladder's multiple choice never goes on a matching board.

The day state is unchanged: a word met today still owes a written-receptive return in a later
session (phase 37 D1), and an Again on any ladder card opens a return in its skill.

Speaking is not on the ladder: speech scoring a word met three cards earlier would fail on
pronunciation as often as on memory. The session's speaking pick (phase 37 D4) is unchanged.

### D4. Slots, and the cap on new words

`LADDER_SLOTS = 3` (new, in `chooseConstants.ts`): a ladder pick takes three of the session's
`SESSION_LENGTH` slots — its three graded cards; the meet card is free. Every other pick takes
one, as today.

`NEW_PER_SESSION = 3` becomes a **ceiling** as well as the reserve: a session holds at most
three ladders, across every pool and every pass, ruling 15's pass past the daily cap included.
`DAY_NEW_CAP` and `NEW_FLOOR` are unchanged.

In the picker (`choosePools`'s `run`):

- A run's capacity is counted in slots: its picks' slots may not pass `slots`, and its picks may
  not pass the groups it held (phase 39 D5, phase 53 R-D6) — two bounds where today there is one
  `n`. `run` returns the slots it used, so `unpicked` passes on slots.
- A ladder joins a run only while `LADDER_SLOTS` slots are free in it. A run with fewer free
  slots skips new words and goes on with the rest.
- The reserve (step 1) counts ladders: `room` is the run's free slots less the speaking pick, the
  returns and the due words, and the reserve is
  `min(fresh, newLeft, sessionNewLeft, max(min(NEW_PER_SESSION, max(NEW_FLOOR, ⌊room / LADDER_SLOTS⌋)), owedLeft))`,
  with `owedLeft` (a target's pace, phase 53 R-D7) itself bounded by the run's free slots over
  `LADDER_SLOTS`.
- Step 6 (new words up to the daily cap) and step 10 (past it) stop at the session's ceiling.
- `TargetSplit.picked` still counts picks.

So a session is at most 10 graded cards plus up to three meet cards. A list of nothing but new
words gives three ladders and one more card: thirteen cards. A backlog of due words still lets
one new word in (`NEW_FLOOR`), as a ladder: three slots, seven reviews, eleven cards. A session
may end with fewer than ten graded cards when only new words are left and fewer than three
slots are free.

### D5. Where a ladder's cards sit

`planCards` places the ladder cards among the session's other cards:

1. The **ladder stream**, stage by stage: every ladder's meet card in pick order, then every
   P1, then every P2, then every P3. With three ladders this is M_A M_B M_C A1 B1 C1 A2 B2 C2
   A3 B3 C3: two other cards between each of a word's cards.
2. The **other cards** (every non-return unit, the board as one unit), ordered as today
   (highest chance first, no type twice in a row where it can be avoided).
3. The two are **merged evenly**: with `a` of the stream's `L` cards and `b` of the `O` other
   units placed, the stream places its next card when `O = 0` or `(a + ½) / L ≤ (b + ½) / O`,
   else the other list does; but a ladder card that would follow a card of its own word goes
   after the next other unit instead, while one is left. (Stage order makes that happen only
   with a single ladder.)
4. The **returns** come last, as today (phase 37 D6).

So no two cards of one word are ever adjacent while the session has another card to put between
them, the gaps are even (research: the shape of the spacing does not matter, only that it is
spaced; Latimier et al. 2021), and the typed P3s fall late in the session. A session of one
ladder and nothing else is its four cards in a row.

### D6. Wire and app

- `MeetQuestionSchema` joins the `Question` union: `type: 'meet'`, `id`, `question` (the form),
  `prompt` (the Hebrew meaning), as `read_aloud` carries them.
- `NextStepRequest` takes a fourth shape, `{ question_id, seen: true }`, and `AnswerInput` the
  same `{ seen: true }`, accepted only on a meet card (`answerFits`); `evaluate` records it with
  verdict `seen` and an empty answer string. A meet card takes no other answer, and no retry.
- `AnswerVerdict` gains `seen`, and `verdictCorrect('seen')` is false. `score` leaves a meet
  card out of the total, as it leaves a skip (phase 25 D9); `missed` leaves it out; `gradesFor`,
  `dimensionsTested` and `evidenceFor` give it nothing; `rightAnswer` is its form.
- **`API_LEVEL` 3 → 4** (ADR 0012): an older app cannot show the card. The app ships after the
  server, as every release does.
- The app: a `MeetCardView` in the session screen's `renderQuestion`, built from the pieces the
  read-aloud card already uses (the form as the prompt, a `SpeakButton`). Its **המשך** sends
  `seen` the way a skip is sent today (`pass('skip')` sets `advanceRequested`): no feedback
  banner, the next card when the server answers. `cardVoice` gives it the form as its arrival
  cue. The progress bar counts it as a step (the server's position); the results screen's score
  does not (the server's `score.total`).
- The seed session (phase 43) is built from seeded questions, not by the picker: it has no meet
  cards.

### D7. Storage and the prepare job

- One migration: `questions_type_known` and `questions_shape_valid` take `meet` (options null,
  prompt not null, alternatives null, tiles null, no context or sentence);
  `answers_verdict_known` takes `seen`. A `seen` answer is stored as a text answer (empty
  `typed_text`, verdict `seen`), which `answers_kind_valid` already allows; `decodeAnswer` reads
  `meet` as a text type (it would otherwise read the null options of a choice), and
  `questionFrom` builds the card from its row.
- The prepare job receives each pick's `ladder` flag in the `PREPARE_SESSION` payload (a pick
  stored without it — a stock prepared before the deploy — is not a ladder). The plan's `order`
  lists a ladder's pick index four times; every position is one card, as today, and the
  existing per-position code (distractors, context, checker, refusals) handles the repeats.
- A meet card asks the models nothing and is never refused. A meet card whose word has no
  practice card left after the refusals (phase 48) is dropped with them: a meet card is never
  the only card of its word.

### D8. The bots

The bots' answer loop answers a meet card with `seen`, and the bot's memory counts the meet
card as a study of the word (as it counts the feedback after a wrong answer). A bot never
guesses at a meet card.

---

## 2. Testing

- **Picker (`choose.test.ts`):** unlearned classification (no memory; all-Again memory; a
  right answer in any skill ends it; a done gloss stays done; a family introduction is not a
  ladder; an unlearned gloss owed a return is `NEW`); a ladder's three slots; the session
  ceiling across two pools and in the past-the-cap pass; a ladder skipped when fewer than three
  slots are free; the reserve with a backlog (one ladder, seven reviews).
- **Plan (`plan.test.ts`):** a ladder's four types in order; ladder cards outside
  `MAX_PER_TYPE` and off the board; the stream and the even merge for one, two and three
  ladders with and without other cards; no two cards of a word adjacent while another card
  exists; returns last.
- **Core (`quiz.test.ts`, `memoryGrades.test.ts`):** `seen` fits only a meet card; a meet card
  out of the score and the missed list; no grades.
- **Prepare job (integration):** a session with a ladder writes meet, P1, P2, P3 for its gloss;
  a meet card is dropped when its practice cards are all refused.
- **Day simulation (`day.test.ts`):** in every run — lane 0's day, the thirty-new-words
  learner, the families runs, every target scenario — every unlearned word's first card of the
  day is a meet card followed by P1, P2, P3; no session holds more than three ladders; no two
  cards of one word are adjacent in a session with another card. The thirty-word learner meets
  all thirty words, three a session at most. Phase 53's outcomes still hold; its ready-on-due
  measures are re-measured and reported, not lowered.
- **e2e:** a new spec plays a session whose new word shows its meet card (the form, the meaning,
  the arrival utterance), **המשך** moves on with no banner, and its three practice cards follow.
  `kindOnScreen` learns the meet card. The specs that play an unseeded new word and expect a
  choice as its first card, or count a session's cards (glosses, progress, next-session,
  answer-language, meaning-recall, new-meaning, ambiguous-questions), are updated to step
  through the meet card and to the new totals.
- **Bots:** `answer.test.ts` / `play.test.ts` answer a meet card with `seen`.

---

## Rulings

(Recorded during the run.)
