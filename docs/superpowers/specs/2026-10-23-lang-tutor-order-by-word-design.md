# Order a session's cards by word

- **Status:** Designed with Victor on 2026-10-23 in chat, from a bug he saw on lane 0 and a
  throwaway proof of concept replayed on lane 0's sessions. He approved the three rulings below and
  said "continue till PR".
- **Date:** 2026-10-23
- **Builds on:** phase 54 D5 and phase 55 D3 (where a ladder's cards sit), phase 37 D6 (returns
  last), phase 67b D4 (the say card in the meeting session), phase 68 D2 (a step-down's cards);
  ADR 0001 (domain stays pure).
- **Replaces:** phase 54 D5's ladder stream and even merge, as phase 55 D3 amended it, and with them
  the stage-by-stage order of several ladders.
- **Touches:** `domain/plan.ts` (`planCards`'s order, `PlanPick`), its one call in
  `services/sessions.ts`, `plan.test.ts`, the day simulation's planned picks (`day.test.ts`).

Lines marked **(Victor)** are his. **(my call)** are Claude's, made in the open.

---

## Goal

A new word was asked "say the translation" before its meet card. Lane 0 has two cases, both vic1's
target sessions: `aff47ecd` (cattivo, 2026-10-21) and `dad95389` (Pragmatic, 2026-10-23). In each,
card 0 is a graded `say_translation` of the word whose meet is card 1, and the learner, who had never
seen the word, used help. That was stored as a miss, and the miss opened a speaking step-down.

**Root cause.** Phase 67b's `firstSay` adds a second pick, a `spoken_productive` TARGET, for a word
its ladder meets in the same session. `planCards` keeps two queues: a ladder stream (a word's intro
stage, then its three practice cards) and every other card. The say card is a separate pick, so it
goes into the other queue. Every target card has p = 1, so ties go to pick index, and the say card
comes first in that queue. The merge starts from the other queue whenever it has more units than the
stream: one ladder has 4 units, so 5 or more other cards put the say card at position 0. The planner
knows words only by pick index, so nothing ties the say card to its word's meet.

The split exists to keep a new word's cards in a fixed order and spread out. It assumes every card of
a new word is in the stream, which held while a new word was exactly one pick. This design keeps
both aims and drops the assumption: the order works by word.

## Non-goals

- Which words a session asks, and each card's type: the pickers and `cardFor` are unchanged.
- Any change to the model calls, the prompts, the database or the app.
- A device that cannot record still gets the 67b say card, which falls back to a second multiple
  choice for the new word. Found by the proof of concept and left out of scope (**my call**).

## D1. The plan knows each card's word

`PlanPick` gains `glossId`, the gloss the pick asks. `services/sessions.ts` passes `row.glossId`.
Two picks with one `glossId` are one word.

## D2. Each word's cards are one sequence

Every unit the plan places belongs to the sequence of its word, in the order the word asks them:

1. its ladder: the intro stage (one unit, as phase 55 D3), then multiple choice, reverse choice,
   typed translation;
2. its step-down: see (when there is one), pick, produce (phase 68 D2);
3. its other cards, in pick order. **(Victor)** The 67b say card is one of these, so it is the new
   word's last card, after its typed translation.

A board is a sequence of its own. It holds four words: criterion 1 below counts it as each of them,
criterion 2 as one sequence.

## D3. One pass places the cards

At each position, every sequence with a unit left offers its next one. Of those, the unit placed is
decided by these criteria in turn, the first that tells two units apart deciding:

1. **Not the word just placed.** No unit of a word placed in the last unit, when another can go.
2. **Every word can still be kept apart.** After the unit, no sequence holds more units than the rest
   can separate: the same test `separable()` makes for types, over each sequence's units left.
3. **Not the type just placed.** The unit's first card is not the last card's type.
4. **Every type can still be kept apart** (`separable()`).
5. **The word furthest behind an even spread.** A word whose `k` of `n` units are placed, at
   position `t` of `T` units, is behind by `(t + ½) / T − (k + ½) / n`; the larger goes first.
6. The higher p, then the lower pick index.

Phase 37 D6 stands: a return is offered only once every unit that is neither a return nor of a
ladder's or a step-down's word is placed.

The rest of `planCards` is unchanged: each pick's card, the board's picks and the step-downs' cards
are chosen as now, and an intro stage's cards stay back to back.

## D4. The type test counts what can be placed now **(my call)**

While returns wait, criterion 4 counts only the units that can go before them. Counting the returns
too made the test refuse orders that were fine, and cost a type repeat in list sessions with returns
(found by the proof of concept's sweep).

## Rulings (Victor, 2026-10-23)

- **R1. A new word always opens its session.** Its meet card comes first (criterion 5: a ladder
  starts furthest behind). Today it opened 16 of lane 0's 24 sessions with a new word.
- **R2. Several new words no longer go strictly stage by stage.** The stages mix where it avoids
  three of one type in a row (criterion 3 before 5).
- **R3. The say card is the new word's last card.** In a session with two new words they end
  "say A, say B".

## Evidence (proof of concept)

The planner inputs pg-boss still held on lane 0 (45 sessions, 39 distinct, 2026-10-22 01:14 to
2026-10-23 08:52), planned both ways. Today's `planCards` on those inputs gives every served session's
order, up to the cards the prepare job later downgraded or dropped.

| | Today | By word |
|---|---|---|
| Cards before their word's meet | 1 | 0 |
| Same word back to back | 37 | 5, all unavoidable |
| Same type back to back | 79 | 41 |
| Mean gap between a word's cards | 3.17 | 3.58 |

A sweep of 5,000 random sessions with every feature (new meanings, list boards, no speaking or
listening, returns, step-downs, two ladders) broke none of the rules below, and today's planner put a
card before its meet in 956 of them. Each word's graded cards keep their order within each skill on
all 232 of lane 0's words, so step-downs and "a skill's first answer of the day" read what they read
today. The day simulation passed 223 of 224 checks; the other is miss-rhythm noise to measure (Tests).

## Tests

`plan.test.ts`:

- The tests that pin phase 54's exact stage-by-stage order are restated as the rules they guard.
- New: no card of a word comes before its meet; the say card follows its word's typed translation; one
  ladder and three others alternate; a board is never next to a card of its words when another card
  can go between; returns still follow every other card.
- New: a seeded sweep of random sessions holds every rule: the same cards as each pick's card choice
  gives, an intro stage together and first, the ladder's practice order, a step-down's order, returns
  last, the board in one piece, no card before its meet.

`sessions.prepare.test.ts`: the ladder's intro-mark test pins the new order (the meet first, R1). Its
"a card before it is dropped" case moves to a step-down's marked cards, since nothing can come before a
ladder's intro stage any more.

The day simulation passes its planned picks' `glossId`. With words grouped, five of its gates moved at
phase 37's five phases (a homework's FSRS share, the fresh homework's day 1, the exam's volume step, the
homework's practice-more share, and the families' "some phase knows m0"). Over thirty learners (missing
every 4th to 8th card, every phase), the new order matches or beats master on each, marks unchanged:
1-day homework FSRS share 0.471 → 0.551, fresh day 1 mean 19.47 → 19.57, words known in the families run
126 → 126. Those five gates are held over the thirty learners (`EVERY_RHYTHM`), with their marks as they
were; the rest stay at the five phases. **(my call)**

## Left to the builder

The names and the shape of the code inside `planCards`, and the sweep's size and seed.
