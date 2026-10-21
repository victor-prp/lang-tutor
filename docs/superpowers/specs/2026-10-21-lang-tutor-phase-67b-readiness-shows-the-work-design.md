# Phase 67b — Readiness that shows the work

- **Status:** Designed with Victor on 2026-10-21 in chat, after two days on phase 67 (lane 0,
  homework `f3ac1e97`: 18 words, created 2026-10-20, due 2026-10-25). Every rule below was simulated
  and shown to him before he chose it.
- **Date:** 2026-10-21
- **Source:**
  - His three findings on phase 67, confirmed from lane 0's data and logs (Goal).
  - The evidence: `drafts/2026-10-21-readiness-progress-evidence/` (main checkout, gitignored).
    `spike.diff` is the throwaway branch `spike-readiness-weakest`: environment switches in
    `readiness.ts`, `targetPicker.ts` and the day simulation (`day.test.ts`, `runPaths`), never
    meant to merge. The `spike-*.json` files are its runs; the three `.html` pages are the charts
    Victor read (also published as private artifacts).
- **Builds on:** phase 65 (readiness as a grade), 65b (practice more past the budget), 67 (two
  cards a day); ADR 0001, 0012.
- **Replaces:** phase 65 D1's word chance as a product; phase 65's same-day bonus before the eve
  (¼ of the gap, at most 2 a skill a day); phase 65b's "ask first" sheet on every done day; phase
  67 D7's word pill number; phase 65 D7's sessions-line words.
- **Touches:** `packages/core` readiness (`wordChance`, `applyReadiness`, a bar per kind), the
  server's `domain/` (targetSummary, targetDay, targetPicker, targetBudget), `services/targets.ts`,
  possibly a migration (D3), the day simulation and target tests; the app's target card, word
  pill, strings and the practice-more sheet; e2e.

Lines marked **(Victor)** are his. **(my call)** are Claude's, made in the open, not yet confirmed.

---

## Goal

Victor's findings, each confirmed in lane 0's data:

1. **"After 5 sessions on the first day I still see readiness is 0% — it demotivates."** The 4
   budgeted sessions of 20 Oct asked 12 writing cards, 11 spelling cards and 0 speaking cards. A
   homework word's chance is writing × spelling × speaking, so every word read 0. The card moved
   (6%, then 11%) only in the two practice-more sessions, which asked speaking. The picker holds a
   new word's second card for a later session, and its tie-break picks writing, then spelling.
2. **"'Done for today' demotivates to make more effort, while it can actually help."** The card
   reads "סיימת להיום ✓" in green once the budget is met; on 20 Oct it said so at 0%.
3. **"If I try to practice more it tells that it will not give much and asks me if I am sure. In
   reality more practice moves readiness upward."** `asksBeforePracticeMore` is true on every day
   but an exam's eve; nothing computes it. On 21 Oct the 4 budgeted sessions added 20 points and
   the 3 extra ones 12.

What he asked for while choosing: "even after the first session I expect to have some progress";
"readiness should go up as he practices more, otherwise it demotivates"; a crammed second day at
87–88% "is too high"; and a way to reach 100% on the eve.

**Done means:**

1. Victor's manual test.
2. Unit tests prove D1–D8, and the day simulation gates the scenarios of Testing.
3. `npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Non-goals

- The plan: two cards a day below 90, one per skill on the eve, the quota of new words, the day's
  budget and how it is counted (phase 67 D2–D5). `READINESS_WORD_READY` (90) still steers it for
  both kinds.
- The main memory (`gloss_memory`, FSRS). Only a target's readiness rows change how they move.
- Showing how much another session would add (Victor: "no").
- Removing the meter (`target_skills`).

## Anti-goals

- Readiness 0% after a first session of work (phase 67 named it and did not prevent it).
- Extra practice that lowers the card before the eve by its later answers (D3). A first answer that
  is a miss still lowers it: that is the forecast learning, not the practice punished.
- A sheet that says practice will not help when it would, or none when it would not.
- A crammed early day that reads near-ready (Victor: 87–88% on a second day "is too high").

---

## Decisions

### D1. A word is as ready as its weakest counted skill **(Victor: "It seems that multiplication is the problem"; "Blue looks good")**

`wordChance` is the minimum of the word's counted skills' chances, not their product. The counted
skills do not change: homework writing, spelling and speaking; a test (בוחן) writing and spelling. A
counted skill never answered still reads 0, so a word never said is not ready.

On lane 0, word `1d2230d4` at writing 92, spelling 94, speaking 94 read 81 (not ready) as a
product and reads 92 as the weakest skill. Everything that reads a word's chance reads the minimum,
the plan's "below 90" included, so a word rests sooner.

### D2. The card counts a word at its bar as 100% **(Victor: homework "count ready words as 100%"; a test at 95, "Yes")**

A target's number (`readiness_pct`, and `readiness_start_pct`, so today's gain too) is the mean
over its words of 100 for a word at its kind's **bar**, else the word's own percent, rounded down.
The bar is 90 for homework and 95 for a test. 100% means every word is at its bar.

- `ready_count` counts words at their kind's bar, so the header's "כל המילים מוכנות …" and the
  "not ready" count agree with the card (my call).
- The word pill shows 100% from its kind's bar, else the word's own percent, green from the bar
  (my call: phase 67 D7 kept the raw percent against Victor's "switch 'ready' to '100%' for
  consistency"; the card now counts it so).
- The plan still steers by 90 for a test: a word at 90–94 rests in the plan, and raising it to 100
  is practice more's work. That is Victor's "for a test I would like to encourage him to practice
  more", with an end he can reach.

### D3. How answers move a target's readiness **(Victor: "the day before the due day has no cap"; "it looks we need to go with 'Only the first answer counts'")**

For a target's readiness rows only (every path that writes them, My words included):

| The day | A skill's first answer today | Every later answer today |
|---|---|---|
| Before the eve (2 days left or more) | counts, right or wrong, as now | **ignored**: no bonus, no later miss |
| The eve (1 day left) | counts, as now | a right closes `READINESS_BONUS_SHARE` (¼) of the gap, **no daily limit**; a miss counts once a day, as now |
| The due date on | frozen, as now | frozen |

- On a test, a right later on the eve also wins back a cold miss's hold (`held` false). Before the
  eve a hold lifts as now, on the first right of a later day. (my reading of Victor's question;
  simulated)
- Why first answers only before the eve: with later misses still counted, the more sessions a day,
  the more skills catch their one miss, and practice can only lower the card. Test of 18 words,
  learner missing 1 card in 5, day 4's end: 83, 76, 73 at 5, 10, 15 sessions a day; with first
  answers only: 81, 84, 84 (`spike-volume2.json`).
- What it does not remove: a first answer that is a miss still lowers the card, as it would the
  next day. Extra sessions ask first answers that would otherwise wait for tomorrow, so a single
  learner's day can end a few points lower with more sessions, depending on where its misses land
  (up to 6 points in one miss phase of the spike). The five-phase mean stays within 0.4 points
  (`spike-volume2.json`, rule `first_only`).
- `target_readiness.bonus_used` is checked 0..2 (`target_readiness_bonus_range`); the eve can pass
  2. Left to the builder: widen the check (a migration) or stop counting past 2.

### D4. A new word is asked its speaking in the session that meets it **(Victor: "Blue looks good"; practice more's ladders my call)**

The session that meets a word by its ladder also asks it "say the translation", as its second card
of the day, wherever speaking is live for it. Two ladders (8 slots) and two say cards fill the 10.
This holds in every mode: owed, past the budget and practice more.

- The ladder's typed answer already grades spelling, so after its first session a homework word
  has all three skills and reads 84% under D1 (lane 0's first-day answers: 84, 84, 84).
- Practice more's ladders: without the say card, a word met early reads 0 and its session moves
  the card by 0, as Victor's extra sessions 5 and 6 on 21 Oct did. The 3-day simulation found it.
- A test gets the same card (my call): one picker rule; a test does not count speaking, but phase
  53 D3 practises it for every kind.

### D5. Practice more asks what can move the card now (my call)

Practice more and the fill past the budget (phase 65b), on every day the eve included, read
readiness **now**, not at the start of the day:

- the words with the lowest card value now first (a word at its bar counts 100, so it comes last);
- per word, its counted skill with the lowest chance now;
- for a test, counted skills only (the spike's test sessions asked 1–3 say cards each, which a
  test does not count).

The owed work does not change: its cards, the eve's check card on a ready word's weakest practised
skill (phase 67 R2) and the budget's play forward stay as phase 67 has them.

Practice more still starts the next words early first (phase 57 D7.3), with D4's say card. Without
this decision an open eve stalls: in the simulation a learner who misses stuck at 93% on the eve,
because a word that dropped that evening was never asked again.

Two narrower rules were simulated and dropped, as no better: before the eve, keeping words at their
bar out of practice more, and asking a counted skill not yet answered today first. The five-phase
means came out the same or up to 2 points lower (`spike-volume2.json`).

### D6. "Another session can raise the card", computed (my call, from Victor's finding 3)

The server says whether one more session today can raise the card. It can when some word is below
its bar and:

- it has not been met yet (practice more meets it); or
- before the eve, it has a counted skill not answered today; or
- it is the eve.

It cannot otherwise, and not at 100%. The wire's `practice_more_little` keeps its name and becomes
"cannot raise the card today" (my call: an older app then asks only when that is true, which is
the honest case; no API level change unless the builder renames it).

### D7. The card's line follows the day **(Victor, line by line)**

| State | Line | Colour | Mark |
|---|---|---|---|
| Before the day's first session | "היעד של היום: 4 תרגולים" · side "כ-20 דקות" | dark grey | none |
| Some done, more than one left | "התחלה טובה · עוד 3 ליעד של היום" | dark grey | none |
| One left | "כמעט שם · עוד תרגול אחד" | dark grey | none |
| Budget met, another session can raise the card (D6) | "עשית עבודה טובה להיום ↑ · עוד כמה תרגולים יחזקו עוד יותר" | the app's blue (`colors.primary`), bold | ↑ |
| Budget met, nothing more can move it today | "עשית עבודה מצוינת להיום ✓ · מחר נחזק עוד" | green (`colors.correct`), bold | ✓ |
| The card at 100% | "עשית את זה! ✓" | green, bold | ✓ |

- The lines are Victor's, word for word. The two parts around "·" may sit on two lines on a phone
  (left to the builder).
- One session: "היעד של היום: תרגול אחד" (my call). A day that ran out of work before its budget
  (today's "1 במקום 2") takes the budget-met lines (my call).
- Which line wins (my call): work owed first, so the three grey lines show while the budget is not
  met, at 100% too (the eve's check cards). Once the budget is met, or on a rest day, a card at
  100% reads "עשית את זה! ✓"; below 100%, the blue or green line by D6. The due date keeps
  "בהצלחה!". A miss on the eve's check that drops the card below 100% brings back the budget-met
  lines.
- Unchanged: the dots (green done, grey to do, blue bonus), the bonus count, the rest day's line,
  the due date's "בהצלחה!", and the screen reader's sentence, which follows the new words.

### D8. The practice-more sheet **(Victor)**

Shown only when the day is done, another session cannot raise the card (D6), the card is below
100% and the learner has not turned it off. Its words:

- Title: "עשית עבודה מצוינת להיום"
- Text: "עוד תרגול היום לא יתרום הרבה"
- Buttons unchanged: "אחזור מחר", "לתרגל בכל זאת", and "אל תציג לי את זה שוב".

Everywhere else "לתרגל עוד" starts the session at once. On 20 and 21 Oct words were still unmet
when the budget was met, so Victor's first extra session each day would have started with no sheet.

### D9. Other words

- The amber strip of the last two days **(Victor)**: "שיעורי הבית מחר ו-3 מילים צריכות חיזוק", in
  place of "…עוד לא מוכנות. עוד תרגול אחד יעזור.". My calls: one word reads "ומילה אחת צריכה
  חיזוק"; a test reads "הבוחן מחר …"; the due date reads "…היום ו-3 מילים צריכות חיזוק" with no
  second sentence either; the count is the words below the kind's bar (D2).
- The target screen's word group "סיימת להיום" becomes "תורגלו היום" (my call).
- The header's "כל המילים מוכנות …" switches on at the kind's bar (D2), so a test does not say "all
  ready" beside 97%.

---

## The evidence

The day simulation with the spike's switches (`runPaths`, the app's plan, picker, ladders and
budgets; phase 37's learner missing 1 card in 5, the mean of its five phases, or never missing).

Runs before 2026-10-21's last fix (D4's say card in practice more) are kept as Victor saw them;
the numbers below that involve practice more are from the runs after it.

**18-word homework due in 5 days, budget only** (the first chart): today's rules 0% after every
session of day 1; D1 + D4 6% after the first session, 20% at day 1's end, 21.8 sessions in all
against 24, readiness on the date 91 against 88, ready by FSRS 0.92 against 0.91.

**18-word test due in 5 days, D1–D5, 10 sessions a day before the eve:** 100% (bar 95) within
the eve's first 11–15 sessions, in four of five miss phases; the forecast alone never passes 99.
The same as homework (bar 90): 11–19. A crammed second day of the test (15 sessions a day): 77%
(`spike-eve100b.json`, `spike-volume2.json`).

**5-word homework due in 3 days** (the third chart):

| Line | Sessions asked (day 1 / 2 / 3) | Day 1 | Day 2 | Day 3 (eve) | Due date |
|---|---|---|---|---|---|
| D1–D8, budget only | 2 / 2 / 2 | 35% | 75% | 94% | 94% |
| D1–D8, + 2 extra a day | 2 / 1 / 2 | 69% | 88% | 96% | 96% |
| D1–D8, + 5 extra a day | 2 / 1 / 2 | 75% | 88% | 99% | 99% |
| Today's app, budget only | 3 / 2 / 2 | 0% | 44% | 85% | 85% |

In one miss phase per kind a word never reaches its bar, however long the eve (root-caused
2026-10-21, `spike-eve100b.json`). The word is asked in every one of 80 eve sessions and answered
wrong 78 times (homework: 74 of 79). Practice more asks it first each session, as D5 wants, so it
sits in the same slot every time, and the learner's fixed every-fifth-card miss lands there. The
simulated learner causes it, not the picker: a learner who misses a word 78 times is not ready.

## Testing

- `readiness.test` (core): D1's minimum; D3 by table: before the eve a later right and a later miss
  are ignored; on the eve rights past two keep closing the gap and a second miss is ignored; the
  hold won back on the eve; frozen from the date.
- `targetSummary.test`: D2's card value and `ready_count` at 90 and 95; the start value and the
  gain.
- `targetPicker.test`: D4's say card after a ladder in owed, past-budget and practice-more
  sessions, not where speaking is not live; D5's order and skill choice before and on the eve,
  counted skills only on a test.
- D6 by table: unmet word, unanswered skill, the eve, all answered, 100%.
- The app: the line, colour and mark of each D7 state; D8's sheet only when D6 says so; the pill
  and header at the kind's bar.
- The day simulation (`day.test`): the scenarios above, gating: the card above 0 after the first
  session of a fresh homework; before the eve, the five-phase mean of a day's end never more than 1
  point lower with more sessions (5, 10, 15 a day), each phase reported, not gated (D3's note); a
  test and a homework reach 100% on the eve with extra sessions; a crammed second day of a test at
  or below its measured mark; and the phase 67 scenarios re-measured. Marks are measured once and
  written with their date. `READY_ON_DUE_PASS` is never lowered (phase 57 §7); a scenario that
  falls below it is a ruling for Victor.
- The eve's 100% gate covers the miss phases whose fixed rhythm does not land on one word every
  session (The evidence); a phase left out is named in the test with its reason (my call).
- e2e: updated where specs read the old line or sheet words.

## Left to the builder

- Where readiness "now" reaches the picker (the stock is built beside a session in flight).
- `bonus_used` past 2 on the eve (D3).
- The two-part line's layout on a phone.
- Whether a renamed wire field is worth an API level (D6).

## Left for Victor at PR time

- Release; `db:migrate` on lane 0 and prod if D3 adds a migration.
- `db:progress:recompute` on lane 0, then prod: every stored readiness changes meaning (D1–D3).
- The Android check of the card's lines and colours.
- The spike's lane: `npm run lane:abandon -- spike_readiness_weakest` from the main checkout, after
  reading its plan (its branch is throwaway and unmerged; its diff is kept in the evidence).

## Rulings

Made while building, each with what it costs if wrong.
