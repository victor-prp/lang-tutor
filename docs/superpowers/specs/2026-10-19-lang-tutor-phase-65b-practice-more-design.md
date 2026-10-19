# Phase 65b — Practice past the budget: the sheet when done, full sessions

- **Status:** Decided with Victor on 2026-10-19 in chat, after using phase 65 on lane 0; he said "yes, go now".
- **Date:** 2026-10-19
- **Builds on:** phase 65 (`2026-10-19-lang-tutor-phase-65-readiness-grade-design.md`: D7 the budget, D9 the
  sheet, rulings R12, R13), phase 57 (D7 the target picker, its anti-goal 1).
- **Amends:** phase 65 D7.7, D7.8, D9's "appears only when the next session could add little", R12.

Lines marked **(Victor)** are his decisions. Lines marked **(my call)** are Claude's.

## Problem

Victor, on lane 0 the evening phase 65 shipped:

1. He met the day's budget and kept practising, and the "practice more" sheet never appeared. Phase 65 R12 asks
   only when every right answer still countable today would add under 2 points; with 25 of his 45 skills still
   holding a same-day bonus, that bound read 4, so the sheet would have waited about five more sessions. And
   while the plan owed anything (two misses had dropped *freddo*'s writing below the cap) it never asks at all.
2. One session past the budget held a single card: the plan owed one skill, and a target session asks only owed
   work (phase 57 anti-goal 1), so it ended after one question. Earlier that day 1- and 2-card sessions came from
   the same rule.

## Decisions

### D1. The sheet asks whenever today's sessions are done **(Victor)**

"לתרגל עוד" on a target whose day reads done (`today.state === 'done'`: the budget is met, or nothing is owed)
opens the sheet, as phase 65 D9 drew it, unless the learner ticked "אל תציג לי את זה שוב".

- **One exception (Victor):** a בוחן's eve (one day left) while not every word is ready — extra practice
  really helps then, so the button starts the session at once.
- The wire keeps `practice_more_little` (no `API_LEVEL` change: the app's rule, `state === 'done' &&
  practice_more_little && !optedOut`, is unchanged); the server now sets it to "ask first": true except on a
  בוחן's eve with words not ready (my call).
- Phase 65's whole-day gain bound (`readinessGainBound`, `READINESS_LITTLE`) has no reader left and is removed
  (my call).
- The sheet's copy stays: past the budget a session adds roughly 1–3 points, against much more from tomorrow's
  first try, so "only a little" holds. Cost (accepted with Victor): in rare cases a session could add 3–4.

### D2. Past the budget, sessions are full **(Victor)**

Once the day's budget is met, counting the session in flight, a target session asks the owed work first and then
fills up to a full session with the practice-more cards (phase 57 D7 step 3: today's extra words, planned words
started early, the hardest cards), with the picker's own limits. This is phase 65 D7.7 as written ("asking any
work still owed first").

- Before the budget is met nothing changes: owed work only, so the budget's count stays exact.
- Phase 57 anti-goal 1 ("no card that serves no owed work while work is owed") gets this one exception, past the
  budget, with the owed cards still first.
- A new picker mode, `past_budget`: phase 57 D7 steps 1–2 and D5's checks, then step 3, sharing one slot count.
  It records the owed words like `owed` for the stock's stale check (my call).
- The day simulation's learner, which plays past the budget until nothing is owed, picks the same way.

## Testing

- **Server domain:** the picker's `past_budget` (owed first, then the fill; within `SESSION_LENGTH`; nothing
  owed reads as practice more); `pastBudget` (budget, sessions done, a session in flight); the sheet's rule (the
  exam eve exception).
- **Server unit:** a target path's choice past the budget asks owed work and fills.
- **Day simulation:** phase 57's gates and `READY_ON_DUE_PASS` hold; if one moves, compared on five-phase
  aggregates against master's (phase 54's lesson), never lowered.
- **e2e:** the sheet appears on the first "לתרגל עוד" after the budget is met.
