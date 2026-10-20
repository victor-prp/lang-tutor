# Phase 67 — Two cards a day: readiness steers a target's practice

- **Status:** Scoped and designed with Victor on 2026-10-20 in chat. He approved the direction ("yes"
  to the simulation's rule, "I would split" for new words) and then said "Go till PR" (CLAUDE.md,
  *Continue till PR*): the questions still open are answered below as **(my call)**.
- **Date:** 2026-10-20
- **Source:**
  - The one-pager: `drafts/2026-10-20-target-prep-one-pager.md` (main checkout, gitignored).
  - The evidence: `drafts/2026-10-20-target-prep-evidence/` (main checkout): a read-only replay of
    lane 0's budget for homework `fe5861d3` on 2026-10-20 (22 sessions offered at 2 days left and
    84% readiness), each word's readiness beside the meter, and a simulation of the rules on the same
    15 words (`sim-rules.mts`, 400 runs a rule, a learner who answers with the memory model's chance).
- **Builds on:** phase 53 (targets), 55 (ladders), 57 (paths, the plan, the target picker, practice
  more), 60 (new meanings), 65 (readiness as a grade, today's budget), 65b (past the budget); ADR
  0001, 0013, 0014.
- **Replaces:** phase 57 D5–D7 as what steers a target's sessions (the cap's climb, the next-day
  check, the plan's quota by practice days, the picker's below-cap work and its three speaking cards a
  session), and phase 65 D7.1's play of that picker with its miss stretch.
- **Touches:** the server's `domain/` (targetDay, targetPicker, targetBudget, targetSummary),
  `services/targetDayRead.ts`, the target view, the day simulation and the target tests; the app's
  word pill (one string); e2e.

Lines marked **(Victor)** are his. **(my call)** are Claude's, made in the open, not yet confirmed.

---

## Goal

At 2 days left and 84% readiness, Victor's 15-word homework asked for 22 sessions: "way too much".
The sessions followed a practice meter climbing to a cap that rises toward the date, which knows how
much was asked, not what is remembered: 74 of the 75 meter values sat at the same 5. Readiness (phase
65) already knows: its words ran from 68 to 95. What matters **(Victor)**: "having as low sessions as
possible so the learner feels it's easy, quality: the learner remembers the words indeed, variety: the
sessions are not boring." A first design with stages felt "right but too complicated".

**Done means:**

1. Victor's manual test. **(Victor)**
2. Unit tests prove it. **(Victor)** The day simulation plays a 5-day homework, a 2-day one and one
   due tomorrow (15 words each) under the new rule, and gates each day's sessions, the session count
   never growing during a day, and FSRS on the date.
3. The evidence's simulation: 16 sessions instead of 52 for the 5-day homework, 9 instead of 39 for
   2 days, 6 instead of 38 for tomorrow (meet + cards; the app's ladders take more, D3), memory on the
   date no lower. (my call: the bar)
4. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Non-goals

- The readiness model (phase 65 D1–D4): how answers move it, the 90 line, the card's look.
- My words (the main path), sessions in stock (phase 43), the "practice more" sheet (phase 65b).
- Removing the meter. `target_skills` is still written at session end and rebuilt by the recompute
  (recorded state, phase 39), but nothing steers by it. Dropping it is a later phase (my call).
- Long targets beyond what D3 does: a בוחן in 20 days with 40 words is not tuned here.

## Anti-goals

- A day's session count that grows during the day (phase 65 D7, kept).
- Asking a card that cannot change anything while owed work is left (phase 57 anti-goal 1, kept).
- Readiness 0% after a first evening of work: a homework word counts writing × spelling × speaking,
  so a first day that never asks speaking shows nothing (why D2 asks two skills, not one).

---

## Decisions

### D1. One score steers: readiness at the start of the day **(Victor: "use the current scores";
the simulation's rule)**

A word's day reads its readiness (phase 65's per-target skills: its row, else the main memory, else
nothing) as it stood **at the start of today**: each counted skill's `before` of its first event
today, else its chance now (what `readinessStartPct` already reads). It does not move during the day,
so the day's work is fixed when the day starts. A word is **ready** at `READINESS_WORD_READY` (90).

### D2. Each day's cards **(Victor: "yes"; numbers from the simulation)**

Per word on its plan (D3), its **practised skills**: writing, spelling and speaking among its live
ones, for every kind (R1: phase 53 D3, Victor: "the kind sets how strict a target is, never which
skills are practised"); spelling only where the device can listen (R4). Whether it is below 90 reads
its readiness, which counts its kind's skills (homework writing, spelling, speaking; a בוחן writing
and spelling):

| The day | Below 90 at the start of today | Ready |
|---|---|---|
| any day before the eve | 2 cards, on 2 different skills | none: it rests |
| the eve (1 day left) | 1 card on each practised skill | 1 check card |

(At most its practised skills: a word that cannot be said has two.) A card **asks** the practised
skill its type serves: translate, gap, sentence, letter tiles, choose-the-word → writing; dictation →
spelling; say translation (also answered by typing) → speaking. A ladder asks writing. Cards answered
today on the target's path count, right or wrong, and so do the cards of the session in flight, as the
picker credits them today. A word's next card asks its practised skill not asked today with the lowest
start chance, then the one whose readiness moved longest ago, then writing, spelling, speaking. Its
card: writing at its recall rung (translate, gap or sentence, as `planCards` chooses), spelling at
rung 1 (dictation; typed when the device cannot listen), speaking at rung 2 (say translation).

**A miss adds no card (my call).** The word stays below 90, so it comes back tomorrow, on all its
skills on the eve. This is what makes the count exact (D5).

On the due date nothing is owed (`due_today`): its session is the last review, one card per word on
its weakest skill, readiness frozen as phase 65 has it.

### D3. New words: split **(Victor: "I would split (8 words a day is already a lot unless the
student feels he can and want to learn more)")**

A word is met (started) by its ladder (phase 55), or a known word by a recall card, or a new meaning
by its new_meaning card (phase 60), as today. Each day's quota of words to meet, in the plan's order
(added, then gloss): `min(8, ceil(unmet / meeting days left))`, where the meeting days run from today
to the halfway day (phase 57 D6's `ceil(total / 2)` days left), at least one; on the eve, every word
still unmet. Words met today count toward it. A word added later joins the unmet ones. Meeting more
is the learner's choice: "practice more" starts the next words early (phase 57 D7.3, unchanged).

| Homework of 15 words | Met each day |
|---|---|
| given 5 days ahead | 5, 5, 5 |
| 2 days ahead | 8, 7 |
| due tomorrow | 15 |

The simulation: spreading 15 words over 5 days costs nothing on the date (93% against 94% meeting all
on day one); over 2 days 8 + 7 costs some (83% against 88%), the price of Victor's 8 a day.

### D4. The day's state and its words

`TargetDay` keeps its shape and states, so the card, home, the target screen, reminders and stock read
it as before. A word is **owed** when it is in today's quota and not started, or it has cards left
today; **done** when its cards are answered (a ready word on a day before the eve is done from the
start); **extra** when practice more started it today beyond the quota; **later** when it waits for
a later quota (`startsIn`: the days until its quota day). The day is `owed`, `done`, `rest` or
`due_today` as before. `owed` lists the skills its cards still ask, in D2's order. Phase 57's next-day
check goes: the second day's two cards are that check. `readinessPct` and `readyCount` read readiness
at the start of today. `nextPracticeIn`: 1 while any word is below 90 or unmet; else the days to the
eve, for its check; else none. `capHalves` stays for the meter's write.

### D5. Today's budget: the picker played forward, exactly (my call)

Phase 65's budget stays as it is recorded and shown (set once at the day's first session, never
raised). Its count is the new picker played forward over the day, every answer right, as now. Because
a miss adds no card (D2), that play is the day itself: the miss stretch and the learner's miss rate
go, and `miss_room` is written 0.

### D6. The target picker

The same steps, read from the new day: first the words to meet (two ladders a session at most, as
`NEW_PER_SESSION`), then two rounds over the words with cards left, the word with the lowest start
readiness first (each word's first card, then its second, so they sit apart); at most two picks a
word a session and `SESSION_LENGTH` slots, as now. **No speaking limit on a target session (my call):**
three a session made 15 say cards take five sessions; `planCards` already keeps one type from
following itself. Practice more, past the budget and the due date's last review keep their order;
their "hardest cards" read the start readiness, the lowest counted skill first, in place of the meter.

### D7. The word pill **(Victor: "switch 'ready' to '100%' for consistency"; my call on the number)**

The target screen's word pill shows the word's own percent at every value, green from 90, in place of
"מוכנה". Not a literal "100%": ready starts at 90, so Grande at 90 would read 100% and the pills would
no longer average to the card's number. A one-string change if Victor wants the literal 100%.

---

## Testing

- `targetDay.test`: D1–D4 by table: the cards a day owes below and above 90, before and on the eve,
  with answers today and in flight; the quota for 5, 2 and 1 days, words added later, the eve taking
  the rest; a word that cannot be said; the states and `nextPracticeIn`.
- `targetPicker.test`: D6: starts, the two rounds, weakest first, two picks a word, no speaking cap,
  practice more and the last review by readiness.
- `targetBudget.test`: the play equals the day's sessions; no miss stretch.
- The day simulation (`day.test`): the phase 57 measures that read the meter's climb go (the plan at
  100% on the eve, cap gates, the 2026-10-16 replay's "100% after N sessions"). New: the 5-day, 2-day
  and due-tomorrow homeworks of 15 words, with the sessions each day, the day's count never growing,
  and FSRS ready-on-due reported and gated at what this phase measures. `READY_ON_DUE_PASS` is never
  lowered (phase 57 §7).
- Services, integration and e2e: updated where they assert the old plan (owed skills, checks, the
  speaking cap, the miss-stretched budget).

## Left to the builder

- Where the start chances are read (`readTargetDay` now needs the readiness rows, the memory and the
  first events of today, which the target view already reads).
- The marks of the new day-simulation scenarios, measured once and written with their date.

## Rulings

Made while building, each with what it costs if wrong.

- **R1 (D2).** Ruling: a word's cards choose among writing, spelling and speaking for every kind;
  only "below 90" reads the kind's counted skills. Phase 53 D3 is Victor's ("the kind sets how
  strict a target is, never which skills are practised"); the first D2 said counted skills, which
  left an exam never practising speaking: FSRS ready-on-due 0.00 against its 0.57 gate. Cost: an
  exam's eve asks three cards, not two.
- **R2 (D2).** Ruling: a ready word's eve check asks its weakest practised skill, not its weakest
  counted one. A counted-only check dropped the exam's FSRS ready-on-due to 0.51 (gate 0.57, never
  lowered). Cost: an exam's check can land on speaking, which its readiness does not count.
- **R3 (D6).** Ruling: practice more asks words met early today (extra) too, lowest readiness
  first, but not while the session in flight is meeting one. Cost: a word met early waits one
  session for its practice-more card.
- **R4 (D2, Review Focus 2).** Ruling: where the device cannot listen, spelling is no practised
  skill of its own: the writing card, whose typed answer grades spelling, asks it. Dictation is
  spelling's only card; its fallback typed card counted as writing, which left spelling owed all
  day. Answers do not record the skill a pick was for, and recording it is a migration. Cost: a
  word on such a device gets one card fewer a day, its spelling read from typed answers alone.
- **R5 (D5).** Ruling: the stock beside the day's last budgeted session is past the budget (phase
  65b) and records the owed word; a miss adds no card, so it is played as it is after a miss too.
  The phase 57 cases "replaced after a miss" are gone. Cost: a card missed on the day's last
  session is not asked again that day.
- **R6 (testing).** Ruling: the day simulation's anti-goal 1 check accepts a card on any skill
  still open while its word has cards left: the stock chosen beside a session in flight ranks ties
  by `movedOn` as it stood then. Cost: none for the count; the card order can differ from home's.
- **R7 (testing).** Ruling: the cold-miss anti-goal scenario misses the cold words' writing on
  every day they are asked, not only the last two: a word ready before its last two days gets no
  writing card then. The anti-goal (a בוחן missed cold reads below 90 on its date) is still gated.
  Cost: the scenario no longer shows earlier rights overridden by the last two days' misses.
- **R8 (testing).** Ruling: the phase 57 measures of the meter's climb are gone from the day
  simulation (the plan at 100% only on the eve, ten practice evenings for a 20-day exam, the
  practice-day carry-over); the 20-day exam now gates every word ready on its date and reports its
  evenings, ungated. Cost: long targets are reported, not tuned (Non-goals).
- **R9 (Done 3).** The bar, measured in the day simulation with the app's ladders (2026-10-20, five
  phases): 21 sessions over 5 days, 12 over 2, 10 for tomorrow, readiness on the date 88, 79 and 74,
  FSRS ready-on-due 0.87, 0.60 and 0.45, gated as `HOMEWORK_PASS`. The scratch simulation's 16 / 9 /
  6 met a word with one card, not a ladder of four. `READY_ON_DUE_PASS` holds: exam 0.76 (≥ 0.57),
  homework 0.94 (≥ 0.85).
- **R10 (D3, final review).** Ruling: a known word already ready waits for the eve's check outside
  the quota (planned, done, no slot), so the words still to meet are met as if it were not there.
  It took a slot a day, so five known words in fifteen made the first day read "rest" with ten
  unmet. Cost: none found.
- **R11 (D5, final review).** Ruling: a stock chosen past the budget is never served again when
  checked (it is checked only when chosen on an earlier day). Kept, it met the next day's budget
  with practice-more cards while every word still owed its own. Cost: one more stock built on such
  a day.
- **R12 (D6, final review).** Ruling: practice more asks a word's skill not asked today first,
  else its weakest, so two practice-more sessions do not repeat the same card. Cost: a weaker
  skill already asked today waits for a later session.

**Open for Victor (final review 4).** Done 3's "memory no lower" holds for the share ready by FSRS
but not for readiness on the date. The reviewer ran the same 15-word homeworks under phase 66's
rules in the day simulation:

| Homework of 15 words | Sessions | Readiness on the date | Ready by FSRS |
|---|---|---|---|
| given 5 days ahead | ~90 → 21 | 94 → 88 | 0.76 → 0.87 |
| given 2 days ahead | ~48 → 12 | 87 → 79 | 0.48 → 0.60 |
| due tomorrow | 25 (capped) → 10 | 81 → 74 | 0.47 → 0.45 |
| the 2026-10-16 replay (6 words) | 14 → 4 | 85 → 78 | 0.83 → 0.50 |

The card's number reads 6–8 points lower on the date. The likely cause, not measured: fewer cards a
day earn fewer same-day bonuses. The share ready by FSRS is as good or better, except a single
evening (0.47 → 0.45) and the 6-word replay (0.83 → 0.50).

