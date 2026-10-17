# Phase 57 — Target skills and a path per target

- **Status:** Victor said "go till PR, subagents" on 2026-10-16 after approving the extra words; the
  rest of the design is self-approved (CLAUDE.md, *Continue till PR*). Built on branch
  `phase-57-target-skills` by subagents: ten tasks, two merges of master (phases 58 and 58b), a final
  review and its fix wave. Every ruling of the run is at the end (R1–R43).
- **Date:** 2026-10-16
- **Source:** `drafts/2026-10-16-target-skills-one-pager.md` (main checkout, gitignored) and its
  evidence folder `drafts/2026-10-16-target-skills-evidence/`; the brainstorming chat of 2026-10-16
  and its mockups (`.superpowers/brainstorm/32129-1792163805/content/`, main checkout).
- **Builds on:** phase 53 (targets: D1–D13, R1–R15), phase 54 (meet new words), phase 55 (the
  intro stage, D5 leftovers), phase 56 (help grades as a miss), phase 43 (the session in stock),
  phase 52 (reminders), phase 46 (known per skill), phase 39 ("derive, then record").
- **Replaces:** phase 53 D4 (readiness from FSRS), D5 (wishes), D6 (the split), D7 (pacing), D11
  (home and the target screen), D12's split check, R1, R3, R5, R7, the target half of R8; phase 55
  D5. Each is listed in §8.

Lines marked **(Victor)** are his decisions. Lines marked **(my call)** are Claude's, made in the
open and not yet confirmed. Everything else follows from those or from the code.

---

## Problem

On 2026-10-16 Victor did a homework list of six Italian words due the next day: 19 sessions in four
hours. The target stayed at "3 of 6 ready" for the last 9 of them. The picker kept asking the same
six cards in written receptive — the one skill that could not improve that day — and never asked
spelling and speaking, the two skills holding three words back.

Phase 53 made a target reuse the main path's memory model (FSRS) and picker inside a shared session.
Both are built for "come back tomorrow": a right answer on a skill already right today changes FSRS
stability not at all, so after the first answers of the day every skill reads recall 1.0, every skill
ties, and the tie falls to written receptive. Readiness ranks by recall on the due date; the picker
by recall today; the two never look at the same number. A target has a date, and a student who is
ready to work harder before it.

## Goal

**Done means:**

1. Main skills — FSRS memory, levels and "known" — are written exactly as today, from every graded
   answer in every session, whatever path it belongs to. **(Victor)**
2. Each active target has **target skills**: per word, the same five skills, each a value 0–10 with
   its own update rule and a cap set by days left. No decay. **(Victor)**
3. A target word's readiness, and every choice the target's picker makes about it, come from target
   skills only. Levels and "known" still come from the main skills. **(Victor)**
4. The student practises each target on its own path: the target's card on home starts a session
   of that target's words only; "My words" starts a session of everything else. **(Victor)**
5. Home and the target screen show, per target and per word, **how today's work is going** and
   **readiness for the date**, as in D9, D11 and D12. **(Victor)**
6. A homework due tomorrow can reach ready for every word the same evening; an exam in three days
   reaches ready only on its eve; an exam in twenty days asks for about nine evenings of practice,
   not twenty. (follows from Victor's cap and strip)
7. In the day simulation, a replay of 2026-10-16's homework (six words, due tomorrow, the same
   misses) never asks a target card that serves no owed work (anti-goal 1), and reaches ready for
   all six words the same evening.
8. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Non-goals

- Any change to FSRS, levels, "known", or to how the main picker treats words in no active target.
  **(Victor)**
- Same-day returns spent by answers in other skills (`today.ts:53`), whole days in the memory model,
  say translation grading spoken receptive: main-path questions, their own follow-ups.
- Reports of how the test went (phase 53 Out).
- Visuals that show several learning paths at once (Victor: "in the future"). This phase only makes
  them possible.
- Tutors acting on targets (phase 53 D2 unchanged).

## Anti-goals

The phase fails, even if every test passes, if:

- While a target has work owed, its session asks a card that serves none of it: a card that raises
  no value still below today's cap, answers no next-day check (D5) and meets no owed word (D6). The
  2026-10-16 loop.
- A target value drops overnight with no miss (the rejected checkpoint model).
- The student is made to wait: no minimum gap between sessions, ever.
- "Ready" is shown before the date can support it, or the readiness bar sits unchanged for days
  while the student practises.

---

## 1. Paths

### D1. A path per target **(Victor)**

A **path** is either the main path ("My words") or one target. Every session belongs to exactly one
path. Each path has its own picker, its own session in stock and its own started session (phase 43
per path, not per enrollment).

- **The target's path** asks only that target's words (D7).
- **The main path** asks only saved words in no active target, with today's picker unchanged
  otherwise. A word leaves the main path the moment it joins an active target and comes back when
  the target ends or the word is removed, with the FSRS history every session kept writing.
- A gloss in two active targets is in both paths, with target skills in each (D3).
- Main skills are written from every session of every path, exactly as today (Done 1).
- An enrollment with no active target has one path, and behaves exactly as today.

Why (Victor): "this way we can control the focus and propose it to the student". It also removes
phase 53's slot split, which caused part of the loop (R5's refill re-asked done words).

### D2. Stock and lifecycle per path (my call)

- The stock job is keyed per path. A path's stock is built while the path is on home (D11): the
  main path always, a target from its creation to the end of its due date.
- A change to a target (phase 53 R10: create, end, words added or removed, date moved, an unsave)
  retires the unstarted stock of that target's path **and** of the main path, since the main path's
  words change with it.
- A stock chosen on an earlier learner day is retired at the home read when the path's plan for
  today differs (phase 53 R4's check, per path, comparing the target's cap and owed words instead of
  the split).
- **Stock lag** (one-pager evidence, cause 3): a target stock chosen while that path's previous
  session is still being played treats that session's target picks as answered right (each card
  credits its `dimensionsTested`), so it asks the next skill rather than the same one again.
  (Final review C1.) When that credit covers every owed word, the stock is practice more; it
  records no owed word, so it is checked like a stock of an earlier day on any day, and replaced
  once a miss in that session leaves work owed. The target's button and its reminder go through
  create, where the check runs, before they enter a stock.
- **Reminders** (phase 52) open the path whose card is first on home (D11). The tick, which counts
  completed sessions of any path, is unchanged.

Today one stock and one started session per enrollment is assumed in many places; each becomes per
path. Found on master `c4d83cc5` (builder to re-check):

- `sessions` has no path column; the unique indexes `sessions_one_stock_per_enrollment` and
  `sessions_one_started_per_enrollment` (`db/schema.ts:1071-1076`) and their `SessionOpen` (409).
  A new column needs a default (ADR 0010).
- `lockNextSession`'s advisory key `next-session:${enrollmentId}` (`repo/sessions.ts:115`);
  `findOpen`'s single `{started, stock}`; `retireStock`; `createNextSession` refusing while anything
  is started (`services/sessions.ts:612`); `currentSession`, `mayBeStale`/`replaceIfStale`;
  `stockSession`'s early return and seed check; `readChoice` taking the single started session as
  in flight; `requestStock`'s singleton key; the locks in `services/targets.ts` and
  `services/vocabulary.ts`.
- The wire: `GET /enrollments/{id}/sessions/current` answers one `current`
  (`CurrentSessionResponseSchema`); the app's `homeActionOf`, `NextSessionProvider`, one
  `start-button` in `LearningSection`, `reminderStartOf`; the bots' `openSession`.
- The seed (the first session of a new enrollment) is the main path's.

Many e2e specs press `start-button`; keeping that test id on "My words" keeps them as they are
(my call).

---

## 2. Target skills

### D3. State **(Victor)**, shape (my call)

`target_skills`: one row per target, gloss and skill: `value` (0–10), the session and learner day
of its last change. Derived from the answer log and recorded (phase 39's "derive, then record",
Victor's standing rule): a recompute from answers rebuilds it, and every change is appended to an
event log (target, gloss, skill, session, before, after, why). A gloss in two targets has rows in
each.

D5's caps include halves, so values are multiples of 0.5; the builder picks the storage
(half-points as integers is one way).

### D4. The update, at session end, beside the main write

In `recordProgress` (`services/sessions.ts`), in the same transaction as the main write (ADR 0001),
at completion and at skip, as the main write runs today; the recompute (`db/progressRecompute.ts`)
rebuilds target skills with it. Per target word asked in the session, per skill the session graded
for it — the same card → skill mapping as the main skills (core's `gradesFor`), so there is no
second table:

| The session gave the skill | Value |
|---|---|
| any Again (wrong, gave up, a spelling near miss) | −2, not below 0 |
| only right, at least one **recall** card | +2, not above today's cap |
| only right, **recognition** cards only | +1, not above today's cap |
| nothing | unchanged |

- **Recall** cards make the student produce the word: typed meaning, typed translation, cloze
  typed, sentence translation, dictation, say translation. **Recognition** cards let them choose
  it: multiple choice, reverse choice, cloze choice, letter tiles, listen choice, matching.
- **At most one change per skill per session.** Drilling inside a session counts once, the shape of
  the level rule `advance`.
- The cap only limits gains. A value above today's cap (the date moved later) stays.
- **Intro cards** (meet) and **read aloud** grade nothing, as today.
- **A helped answer** (phase 56) changes no target value (my call). The main skills still grade it
  wrong. `answers.helped` already records it; core's `evaluate` turns it into `wrong` before
  grading, so the target update reads the column, not the verdict.
- **A spelling near miss** costs −2 like any Again (my call): for an exam it is a spelling error.
- A gloss in two active targets: one answer updates the rows of every active target holding it,
  each against its own cap (my call).

### D5. The cap by days left — no decay **(Victor)**

`daysLeft = daysBetween(today, due_on)`. Victor's steps: **3 → 5, 2 → 8, 1 → 10**. Further out the
cap rises only on **practice days**, at intervals that shrink toward the date, so a long target asks
for practice on some evenings and leaves the others free (Victor approved the strip in the mockup).

Starting table, to be tuned in the day simulation (my call):

| days left | 1 | 2 | 3 | 4 | 5 | 9 | 14 | 20 | 27 | 35+ |
|---|---|---|---|---|---|---|---|---|---|---|
| cap | 10 | 8 | 5 | 4 | 3.5 | 3 | 2.5 | 2 | 1.5 | 1 |

`cap(d)` is the entry of the smallest table day ≥ d: the cap set on the last practice day holds
until the next one. A target created on a day between entries takes that day's cap, so its first
day is always a practice day.

**The next-day check** (my call; Victor approved "next-day check" on the strip): the day after a
word is started (D6), each of its live skills owes one right answer that day, whatever the cap. It
only checks: it moves no value beyond D4's rule, and the readiness bar does not move for it, so the
cap stays one number per target, not per word. Its cards are each skill's recall rung, asked after
any below-cap work. A miss costs −2 as always, which makes the skill below cap again. No check is
owed on the due date.

Accepted by dropping decay (Victor): forgetting is not modelled; early points are capped low instead,
and a miss on a practice day lowers the value. A late starter can climb 0 → 10 on the eve.

### D6. The plan: when each word is started (Victor's rule, my numbers)

A word is **started** when the target first asks it. A word with no main-path history starts with a
ladder, as today; a word that already has one (saved and practised before it joined) starts with
recall cards and no ladder (my call). Either way its target values start at 0 and count only answers
given since it joined the target (`target_words.added_at`), so readiness at creation is 0%, and both
kinds are spread by the plan the same way: thirty known words due in 20 days are not all asked on
day one.

Every word should be started by about the halfway point (daysLeft ≤ half the days the target had when
created, rounded up), spread over the practice days up to it. A target due tomorrow meets every word
on its first day. Words added later join the plan; a word added after the halfway point is owed at
once. The halfway point is recomputed when the date moves.

**Unfinished planned work carries over (Victor).** On any day, what the plan asks for is the plan
as of the latest practice day up to today: the words that should have been started by then, and every
planned word at the cap. Whatever falls short is **owed today**, on any day, scheduled or not. "If he
has 20 words and practised only 2 words 3 days ago, the app should encourage him to practise even if
the planned next practice day is tomorrow."

A word's **work today**: the plan says it should be started by now and it is not, or it is planned
by now and one of its live skills is below today's cap, or it owes its next-day check. A word started
early (D7, practice more) is **extra** that day **(Victor: "planned 10, all done plus 2 extra")**: it
owes nothing more today, so an optional session never turns a done day back into an owed one. From
the next day it is an ordinary started word: it owes the day's cap and its next-day check, and it
counts toward the plan's later quota, which makes its planned day lighter. A target is **done for today** when
no word has work. A **rest day** is a day the target is done before any session: nothing is owed.

---

## 3. The target's picker

### D7. What a target session asks

Pure, reading target skills, the plan and the day's answers — never FSRS — over the target's words.
In order:

1. **Owed words to start:** ladders as today for new words (phase 55's intro stage,
   `NEW_PER_SESSION` a session); recall cards for known ones (D6).
2. **Started words with work today:** the word furthest below today's cap first.
   - Skill: the one furthest below cap; on a tie, the skill whose card moves the most skills still
     below cap (typed translation moves written receptive, written productive and spelling; say
     translation spoken receptive and spoken productive; dictation spoken receptive and spelling),
     then `ORDER`.
   - Card: value 0 → the skill's recognition rung, else its recall rung (`RUNGS`). Speaking is always
     say translation: read aloud writes nothing, and the intro already read the word aloud.
   - A word may take a second card in the same session for a different owed skill, spaced apart
     from the first (my call; it halves the sessions a small list needs).
3. **Done for today ("practice more") (Victor):** extra sessions stay on the target.
   - First, today's extra words (D6) up to today's cap; then the next planned words, started early
     as extra (pulling ahead makes later days lighter).
   - Then the hardest cards: one recall card per word in a productive skill (spelling, written
     productive, speaking), the word whose hard skill was asked longest ago first (my call).
   - A right answer there changes nothing (the value is at cap); a miss costs −2 as always, so the
     target is owed work again and its card says so. Honest: the extra session found a weak spot.
4. While work is owed, a session asks only cards that serve it (anti-goal 1).

Limits (my call): up to 3 speaking cards in a target session (`SPEAKING_PER_SESSION` stays 1 for
the main path: with one, speaking finishes last for every word); `SESSION_LENGTH` words at most; a
target with fewer picks than that makes a shorter session. Phase 53 R6 (target words exempt from
phase 39's waiting) and R9 (speaking skipped for an unspeakable word) carry over.

### D8. New words across paths (my call)

A target's new words count toward the enrollment's daily new-word cap (`DAY_NEW_CAP`), so on a heavy
target day "My words" meets fewer of its own. A target's owed words are never held back by that cap.

---

## 4. Readiness

### D9. Readiness and the two indicators **(Victor)**

Over a word's live skills (speaking skipped for an unspeakable word, phase 53 R9; live as in the
newest session of any path):

- **Readiness %** of a word: the sum of its values ÷ (10 × its live skills). Of a target: the same
  sums over all its words. **Ready** (מוכנה) is 100%: every live skill at 10, so only once the cap
  reaches 10. Shown as a percentage, not a count: with the cap, no word can be ready before the eve,
  and "0 of 8 ready" for four days would not motivate (Victor approved).
- **Today:** per word, done ✓, or the skills it still owes by name, or "later" (not yet planned);
  per target, "today: k of M words", where M is the words with work planned by now and k those done,
  plus the day's extra words when there are any ("+2"). Resets as the cap rises, like a daily goal.
- **Colour (Victor):** the readiness bar and percentage go from red at 0% through orange and yellow
  to green at ready.
- Keep recording FSRS recall on the due date beside the target values (in `session_targets` or its
  successor): it is the yardstick for tuning caps and points, never shown.

---

## 5. The target's date

### D10. A target stays through its date **(Victor)** (amends phase 53 D1)

A target is active from creation to the end of its due date (it was: to the start). On the date its
card reads "הבוחן היום" (or the homework's) with "בהצלחה!" and its final readiness, and offers an
optional **last review** (חזרה אחרונה), with nothing owed (below). On that day
it is first on home, the one exception to D11's order. The next day it ends (`ended_on_date`, as
today) and leaves home. Changing a target on its date is refused as today (my call).

The last review (my call): the cap is 10 on the date, so it first asks the skills still below 10,
furthest below first, then the hardest cards. A student who skipped the eve can still reach 100% that
morning. Nothing is owed, so the card never says "practice now"; its "חזרה אחרונה" is filled while
readiness is below 100% and outlined at 100%.

The exam's eve no longer needs phase 53's "exclusive" rule: the exam has work owed, so its card is
first and its button filled; once done, the student chooses.

---

## 6. The app

### D11. Home, ordered by priority **(Victor)**

One card per path, in this order:

1. Targets with work owed today, nearest due date first.
2. **My words** (title wording to settle; "המילים שלי" in the mockup), with how many words wait for
   review and its start button.
3. Targets done for today, or on a rest day.

A target on its due date is first (D10). The first card's button is filled, every other one is
outlined: while the exam has work, "Practice now" is filled; once it is done, "My words" moves to
the top with the filled button.

The target card:

- **Title, the countdown (Victor, option B):** "בוחן בעוד 5 ימים", the number large and in the
  accent colour. Homework the same with its kind's name; "מחר" for one day left.
- **Today:** "היום: k מתוך M מילים" and a bar.
- **Readiness:** "מוכנות לבוחן: 18%" and a bar, coloured by its percentage (D9).
- **Button:** "לתרגל עכשיו" whenever work is owed — before the first session and after some (Victor:
  "it's a stronger call to action" than "continue").
- **Done for today:** a green line "כל הכבוד! סיימת להיום. נתראה מחר", the today line at k = M ✓, and
  an outlined "לתרגל עוד" that starts D7's practice-more session.
- **Extra (Victor):** words started early today show on the today line as "+2 נוספות" after the ✓,
  and the today bar runs past the plan in a lighter green (`extra-words.html`).
- **Rest day:** "היום אין תרגול לבוחן. התרגול הבא בעוד N ימים", no today line, the readiness bar,
  and the outlined "לתרגל עוד" (my call: consistent with done).

The rest of home (translate, vocabulary, photo import, the new-target button) is unchanged.

### D12. The target screen **(Victor: A, with B on tap)**

- The header: the countdown title, the date, the today line and the readiness bar, as on the card.
- **A — the words in groups:** "נשאר להיום" (work owed), "סיימת להיום" (done today), "נוספו היום"
  (today's extra words, each tagged "בונוס ✓"), "בהמשך" (not yet planned). Each row: the form · its meaning, readiness % in its colour, and "היום ✓" or
  "היום נשאר: איות, כתיבה" (the skills owed, by core's names) or when it starts ("נתחיל מחר").
- **B — tapping a word** opens its live skills, each a bar out of 10 with today's cap marked as a
  line; green at the cap.
- The remove button and the actions (add photos, add a word, change the date, end) are as today.
- The four readiness words of phase 53 D4 (עוד לא התחלנו, בדרך, כמעט מוכנה, מוכנה) give way to the
  percentage; "מוכנה" stays for 100%.

Mockups: `daily-flow-v2.html`, `days-left-options.html` (B), `paths-v2.html`, `target-screen.html`,
`extra-words.html`.
All Hebrew in them is placeholder wording to finish in the build (UI is Hebrew only, RTL).

### D13. The wire (my call)

Additive under ADR 0003: per target, `days_left`, `today` (k, M, state: `owed` | `done` | `rest` |
`due_today`) and today's extra words, readiness %, the next practice day; per word, readiness %, today's state and owed
skills, and on request its skill values and today's cap. Home's read of the paths gives each path's
order and its session state. `ready_count` keeps its name and now counts words at 100%; its meaning
changes, so `API_LEVEL` rises under ADR 0012 (an older app would show "0 of 6 ready" most days).
One cap table serves both kinds.

---

## 7. Testing

- **Domain, pure:** the update rule (D4), `cap` (D5), the plan and work-today (D6), the target
  picker (D7), readiness (D9), home's order (D11).
- **Day simulation** (phase 37's learner, R15's never-missing learner) with new scenarios: homework
  due tomorrow, exam in 3, 5 and 20 days, a skipped practice day (catch-up), the date moved, words
  added after halfway, and the 2026-10-16 replay (Done 7). Measured per scenario: sessions and cards
  to ready, practice evenings, and FSRS recall on the due date per word.
- **Marks.** Master's day-simulation marks on the share of words ready by FSRS on the due date
  (`day.test.ts` on `c4d83cc5`: exam 0.57, homework 0.85, five-phase averages) stay as gates,
  measured as before, and are never lowered (Victor's standing rule). Target readiness at 100% on
  the eve is a new mark beside them. If the strip's rest days cannot meet the FSRS marks, the
  builder tunes D5's table and practice days; if tuning cannot, it comes back to Victor before any
  mark moves.
- **Integration:** stock and started sessions per path, the target-skill write in the session-end
  transaction, recompute, retire-on-change for both paths, the due-date day.
- **E2E:** home with a target in each state (owed, done, rest, due today) and its order; practice
  now starts a target session; the target screen's groups and the tapped word.
- **Bots** (phase 35) practise the main path as today; a target path in the bots is out of scope
  unless they break.

## 8. What goes, what stays

| Phase 53/55 | Now |
|---|---|
| D4 readiness from FSRS at `due_on` | D9, from target skills; FSRS recall on the date kept as a recorded yardstick |
| D5 wishes, D6 split and "exclusive", R1, R5, R7, target half of R8, phase 55 D5 | gone: paths (D1) |
| D7 pacing, R3 | D6's plan |
| D11 home and target screen | D11, D12 |
| D12 split-change check | per-path staleness (D2) |
| R4, R10 | per path (D2) |
| R6, R9 | kept, for the target picker |
| D1 "active while today < due_on" | through the due date (D10) |
| `TARGET_READY`, `TARGET_ALMOST`, `TARGET_STEADY_SLOTS`, `HOMEWORK_LAST_DAY_SLOTS`, `EXAM_RUN_UP_DAYS` | replaced by D5's cap table and D7's limits in `chooseConstants.ts` |

## Constraints

- ADRs: 0001 (layers: the update, cap, plan and picker are pure domain), 0002, 0003 (wire), 0004
  (test buckets), 0007 (the stock job per path), 0011 (the learner unit is the gloss), 0012
  (`API_LEVEL`), 0013 (the learner day); a sessions-belong-to-a-path rule is new and worth its own
  ADR (`create-adr`).
- The UI is Hebrew only, right to left; weekdays Sunday first.
- One phase, one PR.

## Left to the builder

Table and column names, the migration and backfill (existing targets start from their answers via
the recompute), the event log's shape, wire field names, how the stock job keys paths, Hebrew wording
beyond the strings above, the tuned cap table, and how the target picker shares code with
`chooseWords`.

---

## Rulings

Made while executing the plan, each with what it costs if wrong. The ledger of the run kept them
under task ids (in brackets).

**Changes to the approved design**

- **R1. The next-day check only checks** (amends D5's strip, where D-19 was drawn as a cap rise) [builder
  check]. It owes one right answer per live skill; readiness does not move for it, so the cap stays one
  number per target. Cost: the bar does not move on a check day.
- **R2. Hardest cards in practice more go to the word with the fewest half-points in its hard skills**
  (amends D7's "asked longest ago"), and a word the session in flight asks goes last [T3-b, T3-g]: no
  last-asked stamp exists. Cost: order only.
- **R3. A known word starts with a recall card even at 0** [T3-a] (D6 over D7's "0 → recognition").
  Cost: a forgotten known word gets a hard first card.
- **R4. When the picker owes nothing because the session in flight covers it, the stock is a practice-more
  one; such a stock is checked again even the same day, and the app always creates before entering a
  target's unstarted stock** [T3-m, F-C1-b…d]. Final review C1: without it a practice-more stock was played
  while work was owed. Cost: a home tap on a target waits for create's answer.
- **R5. Ending a target skips its started session** [F-I1-a…d], early or by date, so its answers count once
  and it stops counting as today's open session. Cost: a half-played last review is closed for the learner.
- **R6. My words counts only words in no active target** [T5-q, T6-f]; when every word is in a target it
  says "כל המילים שלך כבר בהכנה לבוחן." (or for homework) with no button [F-M2-a].
- **R7. Readiness percentages round down** [T6-a]: 100% only when every live skill is at 10. A word at 100%
  reads "מוכנה"; the card's and header's line keep "100%" [F-T9-a].
- **R8. From the due date on, the target screen shows one list with no today lines** [F-M1-a] (D10: nothing
  owed).
- **R9. A due-today target already at 100% is drawn outlined and My words takes the filled button and the
  reminder** [T8-a, T8-l]; with two due today only the first is filled [T8-m].
- **R10. An empty target has no button and is never first** [F-M3-a].
- **R11. Target readiness 100% on the eve gates learners who practise until done** (the 2026-10-16 replay:
  14 sessions; the 3-day exam); the fixed six-sessions-a-day 14-day scenarios report it (85–86%) [T7-g].
  Victor's steps make the last two days of a 20-word list need about eight sessions each.
- **R12. The FSRS marks gate the serial simulation, as on master** (exam 0.60 ≥ 0.57, homework 0.92 ≥
  0.85). With the stock lag modelled (closest to the app; master never modelled it) they are printed,
  not gated: exam 0.61 before R4's fix and 0.56 after (mark 0.57), homework 0.81 before and 0.83 after
  (mark 0.85) [F-C1-e, F-C1-f]. R4 stays (anti-goal 1 binds); Victor decides whether to accept, tune
  D5's table, or gate the lagged measure.

**Settled during the build**

- **R13. Values and caps are half-points** (0–20) in storage; the wire shows points [T1-c, T6].
- **R14. Only changed skills get a row** [T1-a]; a missing row is 0 [T1-b].
- **R15. Target picks** [T3-c…T3-i]: "furthest below" is the sum of gaps; owed words take picks in two
  rounds; next-day checks take up to two recall cards covering the most checks; in-flight credit is one
  tally per word and skill; the hardest card's skill is the hard skill with the fewest half-points; the
  last review starts unstarted words too.
- **R16. Target sessions plan with the target flag** [T3-l, T5-p]: exempt from MAX_PER_TYPE and from the
  one-word speaking rule. **Speaking**: at most 3 say-translation picks; a ladder's read aloud is not
  counted [T3-o]. **Intro cards** are not in-flight credit [T3-j]. **Early ladders** respect DAY_NEW_CAP
  [T3-n, T5-l].
- **R17. The session-end write** [T4-a…T4-e]: targets as they stood at the session's last answer (as-of
  reading of ended_at and date changes) so the recompute is exact; `target_skills` hangs off
  `target_words` (cascade); instants compared as microsecond UTC text; started_on from the same window.
- **R18. Events carry the session's last answer as their instant** on both paths [F-T4-a]; a recompute
  rebuilds them with new ids, and a removed word's log is gone after it [T4-h].
- **R19. No data migration: the recompute is the backfill** [T4-f] (Left for Victor).
- **R20. Locks** [T4-i, T4-k, T5-h, T5-i]: a per-enrollment progress lock first in every session end and
  every target-word removal; the target row is locked FOR NO KEY UPDATE; ADR 0014 R4 orders path locks,
  stock retirement, the progress lock, writes, then stock requests.
- **R21. The stale check** stores each target stock's owed words (`session_targets.owed_gloss_ids`) and
  replaces a stock when cap or owed words changed [T5-a, T5-b].
- **R22. Only main-path stocks write ended_on_date** and retire an ended target's leftover stock [T5-c].
- **R23. Errors** [T5-d, T5-e]: create on an ended target is 409 `target closed`; another enrollment's
  target is 404, another learner's 403.
- **R24. due_count** [T5-f]: main path, words whose weakest live skill with memory has R ≤ R_TARGET; a
  target path, its owed words.
- **R25. The seed is the main path's** [T5-g]; a learner whose first session is a target's skips it.
- **R26. ADR 0014 has a check script** [T5-j] (two greppable rules, planted violations fire).
- **R27. Families** are computed over every saved word and read on every path (phase 60's new meanings
  reach target sessions too), chosen over each path's own words, recorded only by main-path stocks [T5-k,
  merge 3].
- **R28. Logs** [T5-n, F-I1-d]: session_retired reasons stale_target and target_ended; target_id on target
  paths' stock events; skip reason target_closed; a skip on a target's end logs reason target_ended.
- **R29. The target's wire `session` is a plain read** [T6-d]; a past target read by id answers
  `due_today` [T6-e]; `ready_count` counts words at 100% [T6-g]; `starts_in` comes from the plan [T6-b].
- **R30. Home** [T8-b…T8-i, T8-j, T8-k]: the reminder judges the first card on a targets read made after the
  tap and waits for a target's session rather than falling through to My words [F-CI-1-a, F-CI-1-b];
  homework's wording "שיעורי הבית היום", "לשיעורי הבית"; My words shows "N מילים מחכות לחזרה" only when
  N > 0, singular "מילה אחת מחכה לחזרה"; the button label follows the card's state; the countdown is drawn
  in three parts.
- **R31. The target screen** [T9-a…T9-c]: several skills panels can be open; header ids renamed.
- **R32. Merges** [M1, M2]: phase 58's level removal and 58b's remove-all follow unsave's per-path order;
  the level is judged before the progress lock; ADR 0014 R4 names both.
- **R33. The simulation** [P3, T7]: replay and short exams play until done (at most 25 sessions); 20-word
  long exams use a never-missing learner; scripted misses as on 2026-10-16 (spesa's "soper" left out).
- **R34. e2e** [T10-a…T10-f]: targets made over the API; due-today and rest states written to the lane's
  e2e database; a reminder e2e; MockServer lookups registered before generation.
- **R35. Learner days of a target's creation and its words' additions come from learnerDay** [P4]; bots
  read every instant as today [T5 concern].
- **R36. Planning facts**: a planned started word owing nothing is done [T2-b]; "yesterday" is
  daysBetween = 1 [T2-a].
- **R37. Removing a word restocks main and every holding target** [T5-i, M1]; an unsave always takes the
  progress lock.
- **R38. The stock job key is per path** (`E` main, `E:T` target) [T5].
- **R39. The prepare flag is session-wide** [T5-p].
- **R40. The wire's session summary carries `started`**; a started target session is entered without
  create, on the button and the reminder, and a create answered `session_open` re-reads and enters
  [F2-N1-a…c]. The main path keeps phase 43's start and resume. Final review N1: a session entered and
  left before its first answer had become a dead end.
- **R41. When several targets end on their date, every started session is closed before any progress is
  recorded** (ADR 0014 R4), and a target's end dates its skip by the session's last answer, today when
  none [F2-N2-a, F2-I1-c].
- **R42. A known word's new meaning starts on a target with its single new_meaning card**, one slot, no
  ladder and outside NEW_PER_SESSION; an early one in practice more counts against the day's new-word room
  (phase 60, merge 3).
- **R43. A tapped list word's miss (phase 59) is evidence for target skills as for FSRS**: −2 in written
  productive in every active target holding the word, and it marks the word started (merge 3). Master's
  0041_sentence_words keeps its number; this branch's migration is one 0042_target_skills (0043 since
  merge 4, R44).
- **R44. A tester's question-types session (phase 61) is the main path's** (target_id null), whatever
  target holds its word (merge 4). Its create takes the main path's next-session lock alone (ADR 0014 R4:
  one path lock, a stock retired under it, no progress lock), refuses only the main path's started
  session and seeded stock, as create on the main path does, and leaves a target path's started session
  and stock as they are; the seed check is create's (any session of any path puts the seed behind, R25).
  Its answers count as any session's, target skills included (spec D4: whatever path the session is on);
  R3 binds the main path's picker, not a word a tester chose. Master's
  0042_tester_and_question_type_sessions keeps its number; this branch's migration is regenerated on top
  as 0043_target_skills, statement for statement the old 0042.
