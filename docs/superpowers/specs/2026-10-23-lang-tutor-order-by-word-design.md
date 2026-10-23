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

A board is a sequence of its own. It holds four words, and the word criteria below count it as each
of them.

## D3. One pass places the cards

At each position, every sequence with a unit left offers its next one. Of those, the unit placed is
decided by these criteria in turn, the first that tells two units apart deciding:

1. **A new word's meet first.** At the first position, a ladder's intro stage goes before any other
   unit (R1).
2. **Not the word just placed.** No unit of a word placed in the last unit, when another can go.
3. **Every word can still be kept apart.** After the unit, no word holds more units than the rest can
   separate: the test `separable()` makes for types, over each word's units left, a board counted
   once for each of its words.
4. **Not the type just placed.** The unit's first card is not the last card's type.
5. **Every type can still be kept apart** (`separable()`).
6. **The word that needs the most of the positions left.** A word with `k` of `n` units placed, at
   position `t` of `T` units, needs `(n − k) / (T − t)` of what is left; the larger goes first.
   **(my call, final review)** The first build compared each unit's ideal slot over the whole session,
   `(k + ½) / n` against `(t + ½) / T`: a one-card word's slot is always the middle, so every one-card
   word went before a ladder's last practice cards, which piled up at the end with types repeating.
7. The higher p, then the lower pick index.

Phase 37 D6 stands: a return is offered only once every unit that is neither a return nor of a
ladder's or a step-down's word is placed.

The rest of `planCards` is unchanged: each pick's card, the board's picks and the step-downs' cards
are chosen as now, and an intro stage's cards stay back to back.

## D4. The type test counts what can be placed now **(my call)**

While returns wait, criterion 5 counts only the units that can go before them. Counting the returns
too made the test refuse orders that were fine, and cost a type repeat in list sessions with returns
(found by the proof of concept's sweep).

## Rulings (Victor, 2026-10-23)

- **R1. A new word always opens its session.** Its meet card comes first (criterion 1). Today it
  opened 16 of lane 0's 24 sessions with a new word.
- **R2. Several new words no longer go strictly stage by stage.** The stages mix where it avoids
  three of one type in a row (criterion 4 before 6).
- **R3. The say card is the new word's last card.** In a session of two new words and nothing else
  they end "say A, say B".

## Evidence

The planner inputs pg-boss still held on lane 0 (47 sessions, 2026-10-22 01:14 to 2026-10-23), planned
both ways with the built code. Today's `planCards` on those inputs gives every served session's order,
up to the cards the prepare job later downgraded or dropped.

| | Today | By word |
|---|---|---|
| Cards before their word's meet | 1 | 0 |
| Same word back to back | 39 | 5, all unavoidable (worse in no session) |
| Same type back to back | 82 | 35 (better in 25 sessions, worse in 5) |
| Sessions with a new word that open with its meet | 16 of 24 | 24 of 24 |

A sweep of 4,000 random sessions of each kind, shaped as production makes them (a target board never
beside a ladder; the board counted as its four words):

| Per 4,000 sessions | Today: word / type repeats | By word: word / type repeats |
|---|---|---|
| List (0–2 ladders, returns) | 128 / 4,278 | 178 / 818 |
| Target (0–2 ladders and their say cards, step-downs) | 6,907 / 4,915 | 0 / 583 |
| Target with a board | 9,619 / 1,509 | 1,338 / 880 |

Today puts a card before its meet in 1,703 of the target sessions; by word, in none. The one count that
rises is list sessions' same-word repeats, where the old merge's guard did a little better. Each word's
graded cards keep their order within each skill on all of lane 0's words, so step-downs and "a skill's
first answer of the day" read what they read today.

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
phase 37's five phases (a homework's readiness and FSRS share, the fresh homework's day 1, the exam's
volume step, the homework's practice-more share, and the families' "some phase knows m0"). Those five
are held over thirty learners (`EVERY_RHYTHM`: missing every 4th to 8th card, every phase), marked at
master's reading over the same learners less a point, which raises every mark. **(my call, final
review)** Master against the new order there:

| Over thirty learners | Master | By word |
|---|---|---|
| Homework 5 / 2 / 1 days ahead: readiness on the date | 96.77 / 92.77 / 86.27 | 96.57 / 92.40 / 87.63 |
| Same: share ready by FSRS | 0.936 / 0.711 / 0.471 | 0.942 / 0.729 / 0.551 |
| Fresh homework, day 1: mean, runs under 16 | 19.47, 5 | 19.57, 5 |
| Practice more flagged "can": rose, exam / homework | 0.790 / 0.930 | 0.793 / 0.931 |
| Families: words known, of them m0 | 126, 22 of 30 | 125, 19 of 30 |

Two readings sit just under master (readiness 2 and 5 days ahead, by 0.37 and 0.2) and the families'
m0 is known in fewer runs, though the seven words are known about as often: within the point of noise
a fixed miss rhythm makes. The rest of the simulation stays at the five phases.

## Left to the builder

The names and the shape of the code inside `planCards`, and the sweep's size and seed.
